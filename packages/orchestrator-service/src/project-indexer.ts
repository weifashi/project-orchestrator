import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import type { Stats } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { ProjectIndexEnvelope, ProjectIndexFile, ProjectIndexSymbol } from '@project-orchestrator/contracts';

const MAX_TRACKED_FILES = 20_000;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_INDEX_BYTES = 8 * 1024 * 1024;
const GIT_TIMEOUT_MS = 5_000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;
const execFileAsync = promisify(execFile);

export type ProjectIndexSkipped = Readonly<{
  binary: number;
  generated_or_dependency: number;
  sensitive: number;
  too_large: number;
  unsupported_or_missing: number;
}>;
export type { ProjectIndexEnvelope, ProjectIndexFile, ProjectIndexSymbol } from '@project-orchestrator/contracts';
export type BuildProjectIndexResult = Readonly<{
  envelope: ProjectIndexEnvelope;
  changedFileCount: number;
  reusedFileCount: number;
  skippedFileCount: number;
}>;

const languageByExtension: Readonly<Record<string, string>> = Object.freeze({
  '.c': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.cs': 'csharp', '.css': 'css', '.dart': 'dart',
  '.go': 'go', '.h': 'c', '.hpp': 'cpp', '.html': 'html', '.java': 'java', '.js': 'javascript',
  '.json': 'json', '.jsx': 'javascript', '.kt': 'kotlin', '.kts': 'kotlin', '.md': 'markdown',
  '.mjs': 'javascript', '.php': 'php', '.py': 'python', '.rb': 'ruby', '.rs': 'rust', '.scss': 'scss',
  '.sh': 'shell', '.sql': 'sql', '.swift': 'swift', '.toml': 'toml', '.ts': 'typescript',
  '.tsx': 'typescript', '.vue': 'vue', '.xml': 'xml', '.yaml': 'yaml', '.yml': 'yaml',
});
const dependencyOrGeneratedDirectories = new Set([
  '.dart_tool', '.git', '.gradle', '.next', '.nuxt', '.output', '.pytest_cache', '.turbo',
  '__pycache__', 'build', 'coverage', 'dist', 'node_modules', 'target', 'vendor',
]);
const sensitiveExtensions = new Set(['.cer', '.crt', '.der', '.jks', '.kdbx', '.key', '.keystore', '.p12', '.pem', '.pfx']);
const sensitiveContainers = new Set(['.aws', '.gnupg', '.ssh', '.credentials', '.secrets', 'credentials', 'secrets']);

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function git(root: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', root, ...args], {
      encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER,
    });
    return String(stdout);
  } catch {
    throw new Error('PROJECT_INDEX_UNAVAILABLE: git command failed');
  }
}

async function gitHead(root: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', root, 'rev-parse', '--verify', 'HEAD'], {
      encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER,
    });
    return String(stdout).trim() || 'unborn';
  } catch (error) {
    if ((error as { code?: number | string }).code === 128) return 'unborn';
    throw new Error('PROJECT_INDEX_UNAVAILABLE: git command failed');
  }
}

async function canonicalRoot(root: string): Promise<string> {
  try {
    const absolute = resolve(root);
    const stats = await lstat(absolute);
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error('invalid project root');
    return await realpath(absolute);
  } catch {
    throw new Error('PROJECT_INDEX_UNAVAILABLE: project root is unavailable');
  }
}

function safeCandidate(root: string, path: string): string | undefined {
  if (path.length === 0 || isAbsolute(path) || path.includes('\0')) return undefined;
  const candidate = resolve(root, path);
  const relativePath = relative(root, candidate);
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) return undefined;
  return candidate;
}

function generatedOrDependency(path: string): boolean {
  const parts = path.split('/');
  if (parts.some((part) => dependencyOrGeneratedDirectories.has(part))) return true;
  const lower = path.toLowerCase();
  return lower.endsWith('.freezed.dart') || lower.endsWith('.g.dart') || lower.endsWith('.min.js')
    || lower.endsWith('.min.css') || /(?:^|\.)generated\./.test(basename(lower))
    || /(?:^|\.)gen\.(?:js|jsx|ts|tsx)$/.test(basename(lower));
}

function sensitive(path: string): boolean {
  const name = basename(path).toLowerCase();
  const parts = path.toLowerCase().split('/');
  return name.startsWith('.env') || parts.some((part) => sensitiveContainers.has(part))
    || name === 'credentials' || name.startsWith('credentials.')
    || ['.netrc', '.npmrc', '.pypirc', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'id_rsa'].includes(name)
    || sensitiveExtensions.has(extname(name));
}

function sensitiveContent(bytes: Buffer): boolean {
  const prefix = bytes.subarray(0, Math.min(bytes.length, 16_384)).toString('utf8');
  return /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/.test(prefix)
    || /OPENSSH PRIVATE KEY/.test(prefix)
    || /^PuTTY-User-Key-File-/m.test(prefix)
    || /-----BEGIN PGP PRIVATE KEY BLOCK-----/.test(prefix);
}

function language(path: string): string {
  const name = basename(path).toLowerCase();
  if (name === 'dockerfile') return 'dockerfile';
  if (name === 'makefile') return 'makefile';
  return languageByExtension[extname(name)] ?? 'text';
}

function pushSymbol(symbols: ProjectIndexSymbol[], kind: string, name: string | undefined, line: number): void {
  if (symbols.length < 128 && name && name.length <= 512 && /^[A-Za-z_$][\w$]*$/.test(name)) {
    symbols.push(Object.freeze({ kind, name, line }));
  }
}

function safeImportReference(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('/') || trimmed.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(trimmed)
    || /^file:/i.test(trimmed)) return '[absolute-import]';
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      url.username = '';
      url.password = '';
      url.search = '';
      url.hash = '';
      return url.toString().slice(0, 4096);
    } catch { return '[invalid-url-import]'; }
  }
  return trimmed.slice(0, 4096);
}

function extractTypescript(lines: string[], imports: Set<string>, symbols: ProjectIndexSymbol[]): void {
  for (const [offset, line] of lines.entries()) {
    const importMatch = line.match(/^(?:import|export)\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/) ?? line.match(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/);
    if (importMatch?.[1]) imports.add(importMatch[1]);
    const declaration = line.match(/^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?(class|function|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/);
    if (declaration) pushSymbol(symbols, declaration[1] ?? 'symbol', declaration[2], offset + 1);
  }
}

function extractGo(lines: string[], imports: Set<string>, symbols: ProjectIndexSymbol[]): void {
  let importBlock = false;
  for (const [offset, line] of lines.entries()) {
    if (/^import\s*\(\s*$/.test(line)) { importBlock = true; continue; }
    if (importBlock && /^\)\s*$/.test(line)) { importBlock = false; continue; }
    if (importBlock || /^import\s+/.test(line)) {
      const match = line.match(/"([^"]+)"/);
      if (match?.[1]) imports.add(match[1]);
    }
    const method = line.match(/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/);
    const type = line.match(/^type\s+([A-Za-z_]\w*)/);
    const variable = line.match(/^(const|var)\s+([A-Za-z_]\w*)/);
    if (method) pushSymbol(symbols, line.startsWith('func (') ? 'method' : 'function', method[1], offset + 1);
    else if (type) pushSymbol(symbols, 'type', type[1], offset + 1);
    else if (variable) pushSymbol(symbols, variable[1] ?? 'variable', variable[2], offset + 1);
  }
}

function extractDart(lines: string[], imports: Set<string>, symbols: ProjectIndexSymbol[]): void {
  for (const [offset, line] of lines.entries()) {
    const dependency = line.match(/^(?:import|export|part)\s+['"]([^'"]+)['"]/);
    if (dependency?.[1]) imports.add(dependency[1]);
    const declaration = line.match(/^(class|mixin|enum|extension|typedef)\s+([A-Za-z_]\w*)/);
    if (declaration) pushSymbol(symbols, declaration[1] ?? 'symbol', declaration[2], offset + 1);
    else {
      const fn = line.match(/^(?:[A-Za-z_][\w<>,?]*(?:\[\])?\s+)+([A-Za-z_]\w*)\s*\([^;]*\)\s*(?:async\s*)?(?:\{|=>)/);
      if (fn) pushSymbol(symbols, 'function', fn[1], offset + 1);
    }
  }
}

function extractPython(lines: string[], imports: Set<string>, symbols: ProjectIndexSymbol[]): void {
  for (const [offset, line] of lines.entries()) {
    const from = line.match(/^from\s+([^\s]+)\s+import\s+/);
    if (from?.[1]) imports.add(from[1]);
    const direct = line.match(/^import\s+(.+)/);
    if (direct?.[1]) for (const item of direct[1].split(',')) imports.add(item.trim().split(/\s+as\s+/)[0] ?? '');
    const declaration = line.match(/^(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/);
    if (declaration) pushSymbol(symbols, declaration[1] === 'def' ? 'function' : 'class', declaration[2], offset + 1);
  }
  imports.delete('');
}

function parseFile(path: string, bytes: Buffer): ProjectIndexFile {
  const fileLanguage = language(path);
  const imports = new Set<string>();
  const symbols: ProjectIndexSymbol[] = [];
  const lines = bytes.toString('utf8').split(/\r?\n/);
  if (fileLanguage === 'typescript' || fileLanguage === 'javascript') extractTypescript(lines, imports, symbols);
  else if (fileLanguage === 'go') extractGo(lines, imports, symbols);
  else if (fileLanguage === 'dart') extractDart(lines, imports, symbols);
  else if (fileLanguage === 'python') extractPython(lines, imports, symbols);
  return Object.freeze({
    path, language: fileLanguage, size_bytes: bytes.byteLength, content_sha256: sha256(bytes),
    imports: [...imports].map(safeImportReference).filter(Boolean).sort().filter((value, index, all) => value !== all[index - 1]).slice(0, 64),
    symbols,
  });
}

function previousFiles(envelope: ProjectIndexEnvelope | undefined): Map<string, ProjectIndexFile> {
  if (envelope?.schema_id !== 'project-orchestrator/project-index' || envelope.schema_version !== 1) return new Map();
  return new Map(envelope.data.files.filter((file) => typeof file.path === 'string' && typeof file.content_sha256 === 'string')
    .map((file) => [file.path, file]));
}

export function buildProjectIndex(input: {
  root: string;
  previous?: ProjectIndexEnvelope;
  now?: string;
}): Promise<BuildProjectIndexResult> {
  return buildProjectIndexAsync(input);
}

type BoundedFileRead =
  | Readonly<{ kind: 'ok'; bytes: Buffer; signature: FileSignature }>
  | Readonly<{ kind: 'too_large'; size: number; signature: FileSignature }>
  | Readonly<{ kind: 'unsafe' }>;
type FileSignature = Readonly<{
  dev: number;
  ino: number;
  mode: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}>;
type PathObservation =
  | Readonly<{ kind: 'missing' }>
  | Readonly<{ kind: 'entry'; signature: FileSignature }>;
type Inspection =
  | Readonly<{ path: string; kind: 'source'; bytes: Buffer; observation: PathObservation }>
  | Readonly<{
    path: string;
    kind: keyof ProjectIndexSkipped;
    fingerprint: string;
    observation?: PathObservation;
  }>;

function signature(stats: Stats): FileSignature {
  return Object.freeze({
    dev: stats.dev, ino: stats.ino, mode: stats.mode, size: stats.size,
    mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs,
  });
}

function sameSignature(left: FileSignature, right: FileSignature): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function observePath(candidate: string): Promise<PathObservation> {
  try { return Object.freeze({ kind: 'entry', signature: signature(await lstat(candidate)) }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Object.freeze({ kind: 'missing' });
    throw new Error('PROJECT_INDEX_UNAVAILABLE: project path could not be observed');
  }
}

async function readBoundedFile(candidate: string): Promise<BoundedFileRead> {
  try {
    if (await realpath(candidate) !== candidate) return { kind: 'unsafe' };
  } catch { return { kind: 'unsafe' }; }
  let descriptor;
  try {
    descriptor = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch { return { kind: 'unsafe' }; }
  try {
    const before = await descriptor.stat();
    if (!before.isFile()) return { kind: 'unsafe' };
    const chunks: Buffer[] = [];
    let offset = 0;
    if (before.size <= MAX_FILE_BYTES) {
      while (offset <= MAX_FILE_BYTES) {
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_FILE_BYTES + 1 - offset));
        const { bytesRead } = await descriptor.read(chunk, 0, chunk.length, offset);
        if (bytesRead === 0) break;
        chunks.push(chunk.subarray(0, bytesRead));
        offset += bytesRead;
      }
    }
    const after = await descriptor.stat();
    let stablePath = false;
    let pathStats: Stats | undefined;
    try {
      pathStats = await lstat(candidate);
      stablePath = !pathStats.isSymbolicLink() && pathStats.isFile() && await realpath(candidate) === candidate;
    } catch { /* file changed or disappeared */ }
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || pathStats === undefined || pathStats.dev !== after.dev || pathStats.ino !== after.ino
      || (before.size <= MAX_FILE_BYTES && offset !== before.size) || !stablePath) return { kind: 'unsafe' };
    if (before.size > MAX_FILE_BYTES) {
      return { kind: 'too_large', size: before.size, signature: signature(pathStats) };
    }
    return { kind: 'ok', bytes: Buffer.concat(chunks, offset), signature: signature(pathStats) };
  } finally {
    await descriptor.close();
  }
}

async function inspectTrackedFile(root: string, path: string): Promise<Inspection> {
  if (generatedOrDependency(path)) return { path, kind: 'generated_or_dependency', fingerprint: `skip\0generated\0${path}\0` };
  if (sensitive(path)) return { path, kind: 'sensitive', fingerprint: `skip\0sensitive\0${path}\0` };
  const candidate = safeCandidate(root, path);
  if (!candidate) return { path, kind: 'unsupported_or_missing', fingerprint: `skip\0unsafe\0${path}\0` };
  const initial = await observePath(candidate);
  if (initial.kind === 'missing') {
    return { path, kind: 'unsupported_or_missing', fingerprint: `skip\0missing\0${path}\0`, observation: initial };
  }
  const initialStats = await lstat(candidate);
  if (initialStats.isSymbolicLink() || !initialStats.isFile()) {
    return { path, kind: 'unsupported_or_missing', fingerprint: `skip\0unsafe\0${path}\0`, observation: initial };
  }
  const read = await readBoundedFile(candidate);
  if (read.kind === 'unsafe') throw new Error('PROJECT_INDEX_UNAVAILABLE: project file changed during scan');
  const observation = Object.freeze({ kind: 'entry' as const, signature: read.signature });
  if (read.kind === 'too_large') {
    return { path, kind: 'too_large', fingerprint: `skip\0too-large\0${path}\0${read.size}\0`, observation };
  }
  if (read.bytes.includes(0)) return { path, kind: 'binary', fingerprint: `skip\0binary\0${path}\0`, observation };
  if (sensitiveContent(read.bytes)) {
    return { path, kind: 'sensitive', fingerprint: `skip\0sensitive-content\0${path}\0`, observation };
  }
  return { path, kind: 'source', bytes: read.bytes, observation };
}

async function assertStableObservations(
  root: string,
  observations: ReadonlyArray<Readonly<{ path: string; observation: PathObservation }>>,
): Promise<void> {
  for (let offset = 0; offset < observations.length; offset += 32) {
    const stable = await Promise.all(observations.slice(offset, offset + 32).map(async (item) => {
      const candidate = safeCandidate(root, item.path);
      if (!candidate) return false;
      try {
        const current = await observePath(candidate);
        if (item.observation.kind === 'missing') return current.kind === 'missing';
        return current.kind === 'entry' && sameSignature(item.observation.signature, current.signature);
      } catch { return false; }
    }));
    if (stable.some((value) => !value)) {
      throw new Error('PROJECT_INDEX_UNAVAILABLE: repository changed during scan');
    }
    await new Promise<void>((resolveYield) => setImmediate(resolveYield));
  }
}

async function buildProjectIndexAsync(input: {
  root: string;
  previous?: ProjectIndexEnvelope;
  now?: string;
}): Promise<BuildProjectIndexResult> {
  const root = await canonicalRoot(input.root);
  const tracked = (await git(root, ['ls-files', '-z'])).split('\0').filter(Boolean).sort();
  if (tracked.length > MAX_TRACKED_FILES) throw new Error('PROJECT_INDEX_UNAVAILABLE: tracked file limit exceeded');
  const sourceHead = await gitHead(root);

  const previous = previousFiles(input.previous);
  const files: ProjectIndexFile[] = [];
  const observations: Array<Readonly<{ path: string; observation: PathObservation }>> = [];
  const fingerprintEntries: string[] = [];
  const skipped = { binary: 0, generated_or_dependency: 0, sensitive: 0, too_large: 0, unsupported_or_missing: 0 };
  let totalBytes = 0;
  let indexBytes = 0;
  let reusedFileCount = 0;
  for (let offset = 0; offset < tracked.length; offset += 8) {
    const inspected = await Promise.all(tracked.slice(offset, offset + 8)
      .map((path) => inspectTrackedFile(root, path)));
    for (const item of inspected) {
      if (item.observation) observations.push(Object.freeze({ path: item.path, observation: item.observation }));
      if (item.kind !== 'source') {
        skipped[item.kind] += 1;
        fingerprintEntries.push(item.fingerprint);
        continue;
      }
      totalBytes += item.bytes.length;
      if (totalBytes > MAX_TOTAL_BYTES) throw new Error('PROJECT_INDEX_UNAVAILABLE: source byte limit exceeded');
      const contentHash = sha256(item.bytes);
      const old = previous.get(item.path);
      let record: ProjectIndexFile;
      if (old?.content_sha256 === contentHash) {
        record = old;
        reusedFileCount += 1;
      } else {
        record = parseFile(item.path, item.bytes);
      }
      indexBytes += Buffer.byteLength(JSON.stringify(record), 'utf8');
      if (indexBytes > MAX_INDEX_BYTES) throw new Error('PROJECT_INDEX_UNAVAILABLE: index metadata limit exceeded');
      files.push(record);
      fingerprintEntries.push(`file\0${item.path}\0${contentHash}\0`);
    }
    await new Promise<void>((resolveYield) => setImmediate(resolveYield));
  }

  await assertStableObservations(root, observations);
  const trackedAfter = (await git(root, ['ls-files', '-z'])).split('\0').filter(Boolean).sort();
  const sourceHeadAfter = await gitHead(root);
  if (sourceHeadAfter !== sourceHead || trackedAfter.length !== tracked.length
    || trackedAfter.some((path, index) => path !== tracked[index])) {
    throw new Error('PROJECT_INDEX_UNAVAILABLE: repository changed during scan');
  }

  files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const current = new Map(files.map((file) => [file.path, file.content_sha256]));
  const paths = new Set([...previous.keys(), ...current.keys()]);
  const changedFileCount = [...paths].filter((path) => previous.get(path)?.content_sha256 !== current.get(path)).length;
  const treeFingerprint = sha256(fingerprintEntries.sort().join(''));
  const skippedFileCount = Object.values(skipped).reduce((sum, count) => sum + count, 0);
  return Object.freeze({
    envelope: Object.freeze({
      schema_id: 'project-orchestrator/project-index', schema_version: 1,
      data: Object.freeze({
        source_head: sourceHead, tree_fingerprint: treeFingerprint,
        generated_at: input.now ?? new Date().toISOString(), files, skipped,
      }),
    }),
    changedFileCount, reusedFileCount, skippedFileCount,
  });
}
