import { randomUUID } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type Database from 'better-sqlite3';
import type { ContentStore } from '@project-orchestrator/content-store';
import {
  ContractValidator,
  ProjectIndexEnvelopeSchema,
  ProjectIndexQueryResultSchema,
  type ProjectIndexEnvelope,
  type ProjectIndexFile,
  type ProjectIndexQueryFile,
  type ProjectIndexQueryResult,
} from '@project-orchestrator/contracts';
import { buildProjectIndex, type BuildProjectIndexResult } from './project-indexer.js';

type IndexRow = {
  id: string;
  project_id: string;
  source_head: string;
  tree_fingerprint: string;
  content_object_id: string;
  file_count: number;
  skipped_file_count: number;
  created_at: string;
};
type BindingRow = IndexRow & { changed_file_count: number; bound_at: string };
type ObservationRow = IndexRow & { binding_rowid: number };
type StageContext = {
  project_id: string;
  canonical_path: string;
  role_bundle_object_id: string;
  role_version_id: string;
};
type AttemptState = { status: string; latest_attempt_id: string | null };
type FrozenRoleBundle = { roles: Array<{ roleVersionId: string; envelope: { data: { slug: string } } }> };

type ResearchContext = Readonly<{
  applicable: boolean;
  projectId?: string;
  canonicalPath?: string;
}>;

export type EnsureProjectIndexResult = Readonly<{
  status: 'ready' | 'not_applicable';
  projectIndexObjectId?: string;
}>;
export type ProjectIndexer = (input: {
  root: string;
  previous?: ProjectIndexEnvelope;
  now?: string;
}) => Promise<BuildProjectIndexResult>;

const validator = new ContractValidator();
const MAX_QUERY_BYTES = 4096;
const BASELINE_CHANGED = Symbol('PROJECT_INDEX_BASELINE_CHANGED');
const EXACT_INDEX_CHANGED = Symbol('PROJECT_INDEX_EXACT_CHANGED');
const ATTEMPT_BECAME_STALE = Symbol('PROJECT_INDEX_ATTEMPT_BECAME_STALE');

function parseEnvelope(bytes: Uint8Array): ProjectIndexEnvelope {
  let value: unknown;
  try { value = JSON.parse(Buffer.from(bytes).toString('utf8')); } catch { throw new Error('PROJECT_INDEX_CORRUPT'); }
  try { return validator.check(ProjectIndexEnvelopeSchema, value); }
  catch { throw new Error('PROJECT_INDEX_CORRUPT'); }
}

function canonicalDirectory(path: string): string | undefined {
  try {
    const absolute = resolve(path);
    const stats = lstatSync(absolute);
    if (!stats.isDirectory() || stats.isSymbolicLink()) return undefined;
    return realpathSync(absolute);
  } catch { return undefined; }
}

function truncate(value: string, maximum: number): { value: string; truncated: boolean } {
  if (value.length <= maximum) return { value, truncated: false };
  return { value: `${value.slice(0, maximum - 1)}…`, truncated: true };
}

function projectFile(file: ProjectIndexFile): ProjectIndexQueryFile {
  const path = truncate(file.path, 1024);
  let detailsTruncated = false;
  const projectedImports = file.imports.slice(0, 10).map((value) => {
    const item = truncate(value, 512);
    detailsTruncated ||= item.truncated;
    return item.value;
  });
  const imports = [...new Set(projectedImports)];
  detailsTruncated ||= imports.length < projectedImports.length;
  const symbols = file.symbols.slice(0, 20).map((symbol) => {
    const name = truncate(symbol.name, 256);
    detailsTruncated ||= name.truncated;
    return Object.freeze({ kind: symbol.kind, name: name.value, line: symbol.line });
  });
  detailsTruncated ||= imports.length < file.imports.length || symbols.length < file.symbols.length;
  return {
    path: path.value,
    language: file.language,
    imports,
    symbols,
    import_count: file.imports.length,
    symbol_count: file.symbols.length,
    path_truncated: path.truncated,
    details_truncated: detailsTruncated,
  };
}

function wireBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolveYield) => setImmediate(resolveYield));
}

function changedFileCount(previous: ProjectIndexEnvelope | undefined, current: ProjectIndexEnvelope): number {
  const before = new Map(previous?.data.files.map((file) => [file.path, file.content_sha256]) ?? []);
  const after = new Map(current.data.files.map((file) => [file.path, file.content_sha256]));
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((path) => before.get(path) !== after.get(path)).length;
}

function isSqliteOperationalError(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code ?? '') : '';
  return ['SQLITE_BUSY', 'SQLITE_LOCKED', 'SQLITE_FULL', 'SQLITE_IOERR', 'SQLITE_NOMEM',
    'SQLITE_READONLY', 'SQLITE_CANTOPEN', 'SQLITE_PROTOCOL', 'SQLITE_INTERRUPT']
    .some((prefix) => code === prefix || code.startsWith(`${prefix}_`));
}

export function isProjectIndexAvailabilityError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith('PROJECT_INDEX_UNAVAILABLE') || message.startsWith('PROJECT_INDEX_CORRUPT')
    || message.startsWith('PROJECT_PATH_CHANGED');
}

export class ProjectIndexService {
  constructor(
    readonly db: Database.Database,
    readonly content: ContentStore,
    readonly indexer: ProjectIndexer = buildProjectIndex,
  ) {}

  validateResearchStage(input: {
    runId: string;
    stageRunId: string;
    canonicalProjectPath: string;
  }): ResearchContext {
    const context = this.db.prepare(`SELECT r.project_id,p.canonical_path,s.role_bundle_object_id,sr.role_version_id
      FROM runs r JOIN projects p ON p.id=r.project_id JOIN run_snapshots s ON s.run_id=r.id
      JOIN stage_runs sr ON sr.id=? AND sr.run_id=r.id WHERE r.id=?`)
      .get(input.stageRunId, input.runId) as StageContext | undefined;
    if (!context) throw new Error('NOT_FOUND: project index stage context');
    const bundle = this.readJson<FrozenRoleBundle>(context.role_bundle_object_id);
    const role = bundle.roles.find((candidate) => candidate.roleVersionId === context.role_version_id);
    if (!role) throw new Error('POLICY_VIOLATION: project index role is absent from frozen bundle');
    if (role.envelope.data.slug !== 'research') return Object.freeze({ applicable: false });
    const storedPath = canonicalDirectory(context.canonical_path);
    const authenticatedPath = canonicalDirectory(input.canonicalProjectPath);
    if (!storedPath || !authenticatedPath || storedPath !== authenticatedPath) {
      throw new Error('PROJECT_PATH_CHANGED: authenticated project does not match Run project');
    }
    return Object.freeze({ applicable: true, projectId: context.project_id, canonicalPath: storedPath });
  }

  async ensureForResearchAttempt(input: {
    runId: string;
    stageRunId: string;
    attemptId: string;
    canonicalProjectPath: string;
  }): Promise<EnsureProjectIndexResult> {
    let context: ResearchContext;
    try { context = this.validateResearchStage(input); }
    catch (error) {
      if (isSqliteOperationalError(error)) {
        throw new Error('PROJECT_INDEX_UNAVAILABLE: SQLite could not validate the project index context');
      }
      throw error;
    }
    if (!context.applicable || !context.projectId || !context.canonicalPath) return { status: 'not_applicable' };
    const projectId = context.projectId;
    const canonicalPath = context.canonicalPath;
    try {
      const attempt = this.db.prepare(`SELECT sa.status,sr.latest_attempt_id FROM stage_runs sr
        JOIN stage_attempts sa ON sa.id=? AND sa.stage_run_id=sr.id WHERE sr.id=? AND sr.run_id=?`)
        .get(input.attemptId, input.stageRunId, input.runId) as AttemptState | undefined;
      if (!attempt) throw new Error('NOT_FOUND: project index attempt context');
      if (attempt.status !== 'running' || attempt.latest_attempt_id !== input.attemptId) {
        throw new Error('POLICY_VIOLATION: project index requires the active attempt');
      }

      const bound = this.binding(input.runId);
      if (bound) {
        this.verifyIndexRow(bound);
        return { status: 'ready', projectIndexObjectId: bound.content_object_id };
      }

      const previousRow = this.latestObservation(projectId);
      const previous = previousRow ? this.verifyIndexRow(previousRow) : undefined;
      let built: BuildProjectIndexResult;
      try {
        built = await this.indexer({ root: canonicalPath, ...(previous === undefined ? {} : { previous }) });
      } catch (error) {
        if (isProjectIndexAvailabilityError(error)) throw error;
        throw new Error('PROJECT_INDEX_UNAVAILABLE: index build failed');
      }
      try { validator.check(ProjectIndexEnvelopeSchema, built.envelope); }
      catch { throw new Error('PROJECT_INDEX_CORRUPT: indexer returned an invalid envelope'); }

      let exact = this.exactIndex(projectId, built.envelope);
      if (exact) this.verifyIndexRow(exact);
      let staged: ReturnType<typeof this.content.putCanonicalJson> | undefined;
      if (!exact) {
        try { staged = this.content.putCanonicalJson(built.envelope); }
        catch (error) {
          if (isSqliteOperationalError(error)) throw error;
          throw new Error('PROJECT_INDEX_CORRUPT: content store rejected project index');
        }
        try { this.content.verify(staged.id); }
        catch (error) {
          if (isSqliteOperationalError(error)) throw error;
          throw new Error('PROJECT_INDEX_CORRUPT: persisted project index failed verification');
        }
      }

      for (let retry = 0; retry < 8; retry += 1) {
        const concurrentBinding = this.binding(input.runId);
        if (concurrentBinding) {
          this.verifyIndexRow(concurrentBinding);
          return { status: 'ready', projectIndexObjectId: concurrentBinding.content_object_id };
        }

        const baselineRow = this.latestObservation(projectId);
        const baseline = baselineRow ? this.verifyIndexRow(baselineRow) : undefined;
        const runChangedFileCount = changedFileCount(baseline, built.envelope);
        exact = this.exactIndex(projectId, built.envelope);
        if (exact) this.verifyIndexRow(exact);
        const now = new Date().toISOString();

        let finalBinding: BindingRow;
        try {
          finalBinding = this.db.transaction(() => {
            const alreadyBound = this.binding(input.runId);
            if (alreadyBound) return alreadyBound;
            const active = this.db.prepare(`SELECT sa.status,sr.latest_attempt_id FROM stage_runs sr
              JOIN stage_attempts sa ON sa.id=? AND sa.stage_run_id=sr.id WHERE sr.id=? AND sr.run_id=?`)
              .get(input.attemptId, input.stageRunId, input.runId) as AttemptState | undefined;
            if (!active || active.status !== 'running' || active.latest_attempt_id !== input.attemptId) {
              throw ATTEMPT_BECAME_STALE;
            }
            if (this.latestObservationRowId(projectId) !== (baselineRow?.binding_rowid ?? null)) {
              throw BASELINE_CHANGED;
            }
            const currentExact = this.exactIndex(projectId, built.envelope);
            if (currentExact && currentExact.id !== exact?.id) throw EXACT_INDEX_CHANGED;
            let index = currentExact;
            if (!index) {
              if (!staged) throw EXACT_INDEX_CHANGED;
              const id = randomUUID();
              const skippedFileCount = Object.values(built.envelope.data.skipped)
                .reduce((sum, count) => sum + count, 0);
              this.db.prepare(`INSERT INTO project_indexes
                (id,project_id,source_head,tree_fingerprint,content_object_id,file_count,skipped_file_count,created_at)
                VALUES(?,?,?,?,?,?,?,?)`).run(
                id, projectId, built.envelope.data.source_head, built.envelope.data.tree_fingerprint,
                staged.id, built.envelope.data.files.length, skippedFileCount, now,
              );
              index = this.db.prepare('SELECT * FROM project_indexes WHERE id=?').get(id) as IndexRow;
            }
            this.db.prepare(`INSERT INTO run_project_indexes
              (run_id,project_index_id,stage_run_id,stage_attempt_id,changed_file_count,bound_at) VALUES(?,?,?,?,?,?)`)
              .run(input.runId, index.id, input.stageRunId, input.attemptId, runChangedFileCount, now);
            const inserted = this.binding(input.runId);
            if (!inserted) throw new Error('PROJECT_INDEX_BINDING_FAILED');
            return inserted;
          }).immediate();
        } catch (error) {
          if (error === BASELINE_CHANGED || error === EXACT_INDEX_CHANGED) continue;
          if (error === ATTEMPT_BECAME_STALE) {
            throw new Error('PROJECT_INDEX_UNAVAILABLE: Research attempt changed during scan');
          }
          throw error;
        }

        this.verifyIndexRow(finalBinding);
        return { status: 'ready', projectIndexObjectId: finalBinding.content_object_id };
      }
      throw new Error('PROJECT_INDEX_UNAVAILABLE: concurrent index updates did not settle');
    } catch (error) {
      if (isSqliteOperationalError(error)) {
        throw new Error('PROJECT_INDEX_UNAVAILABLE: SQLite could not persist the project index');
      }
      throw error;
    }
  }

  async queryForRun(input: {
    runId: string;
    query?: string;
    language?: string;
    cursor?: number;
    limit?: number;
  }): Promise<ProjectIndexQueryResult> {
    const row = this.binding(input.runId);
    if (!row) return validator.check(ProjectIndexQueryResultSchema,
      Object.freeze({ status: 'unavailable', reason: 'PROJECT_INDEX_UNAVAILABLE' }));
    let envelope: ProjectIndexEnvelope;
    try { envelope = this.verifyIndexRow(row); }
    catch { return validator.check(ProjectIndexQueryResultSchema,
      Object.freeze({ status: 'unavailable', reason: 'PROJECT_INDEX_CORRUPT' })); }
    const query = input.query?.trim().toLowerCase() ?? '';
    const filterLanguage = input.language?.trim().toLowerCase();
    const matching: ProjectIndexFile[] = [];
    for (const [offset, file] of envelope.data.files.entries()) {
      if (filterLanguage && file.language.toLowerCase() !== filterLanguage) continue;
      if (!query || file.path.toLowerCase().includes(query)
        || file.imports.some((dependency) => dependency.toLowerCase().includes(query))
        || file.symbols.some((symbol) => symbol.name.toLowerCase().includes(query))) matching.push(file);
      if (offset > 0 && offset % 256 === 0) await yieldToEventLoop();
    }
    const cursor = Math.min(20_000, Math.max(0, Math.floor(input.cursor ?? 0)));
    const limit = Math.min(20, Math.max(1, Math.floor(input.limit ?? 10)));
    const files: ProjectIndexQueryFile[] = [];
    let consumed = 0;
    while (cursor + consumed < matching.length && consumed < limit) {
      const candidate = projectFile(matching[cursor + consumed]!);
      const candidateImports = [...candidate.imports];
      const candidateSymbols = [...candidate.symbols];
      let projected = candidate;
      const resultWith = () => ({
        status: 'ready', project_index_object_id: row.content_object_id, source_head: row.source_head,
        tree_fingerprint: row.tree_fingerprint, freshness: 'frozen', bound_at: row.bound_at,
        file_count: row.file_count, changed_file_count: row.changed_file_count, skipped_file_count: row.skipped_file_count,
        matched_file_count: matching.length, cursor, files: [...files, projected],
        next_cursor: cursor + consumed + 1 < matching.length ? cursor + consumed + 1 : null,
      });
      while (wireBytes(resultWith()) >= MAX_QUERY_BYTES) {
        if (candidateSymbols.length > 0) candidateSymbols.pop();
        else if (candidateImports.length > 0) candidateImports.pop();
        else if (projected.path !== '[oversized-path]') {
          projected = { ...projected, path: '[oversized-path]', path_truncated: true, details_truncated: true };
          continue;
        } else {
          break;
        }
        projected = { ...projected, imports: candidateImports, symbols: candidateSymbols, details_truncated: true };
      }
      if (wireBytes(resultWith()) >= MAX_QUERY_BYTES) break;
      files.push(projected);
      consumed += 1;
    }
    const nextOffset = cursor + consumed;
    const result = Object.freeze({
      status: 'ready' as const, project_index_object_id: row.content_object_id, source_head: row.source_head,
      tree_fingerprint: row.tree_fingerprint, freshness: 'frozen' as const, bound_at: row.bound_at,
      file_count: row.file_count, changed_file_count: row.changed_file_count, skipped_file_count: row.skipped_file_count,
      matched_file_count: matching.length, cursor, files: Object.freeze(files),
      next_cursor: nextOffset < matching.length ? nextOffset : null,
    });
    try {
      const checked = validator.check(ProjectIndexQueryResultSchema, result);
      if (wireBytes(checked) >= MAX_QUERY_BYTES) throw new Error('PROJECT_INDEX_QUERY_OVERSIZED');
      return checked;
    } catch {
      return validator.check(ProjectIndexQueryResultSchema,
        Object.freeze({ status: 'unavailable', reason: 'PROJECT_INDEX_CORRUPT' }));
    }
  }

  private verifyIndexRow(row: IndexRow): ProjectIndexEnvelope {
    let envelope: ProjectIndexEnvelope;
    try { envelope = parseEnvelope(this.content.read(row.content_object_id)); }
    catch { throw new Error('PROJECT_INDEX_CORRUPT'); }
    const skipped = Object.values(envelope.data.skipped).reduce((sum, count) => sum + count, 0);
    if (envelope.data.source_head !== row.source_head || envelope.data.tree_fingerprint !== row.tree_fingerprint
      || envelope.data.files.length !== row.file_count || skipped !== row.skipped_file_count) {
      throw new Error('PROJECT_INDEX_CORRUPT');
    }
    return envelope;
  }

  private binding(runId: string): BindingRow | undefined {
    return this.db.prepare(`SELECT pi.*,rpi.changed_file_count,rpi.bound_at FROM run_project_indexes rpi
      JOIN project_indexes pi ON pi.id=rpi.project_index_id WHERE rpi.run_id=?`).get(runId) as BindingRow | undefined;
  }

  private latestObservation(projectId: string): ObservationRow | undefined {
    return this.db.prepare(`SELECT rpi.rowid AS binding_rowid,pi.* FROM run_project_indexes rpi
      JOIN project_indexes pi ON pi.id=rpi.project_index_id
      WHERE pi.project_id=? ORDER BY rpi.rowid DESC LIMIT 1`).get(projectId) as ObservationRow | undefined;
  }

  private latestObservationRowId(projectId: string): number | null {
    const row = this.db.prepare(`SELECT rpi.rowid AS binding_rowid FROM run_project_indexes rpi
      JOIN project_indexes pi ON pi.id=rpi.project_index_id
      WHERE pi.project_id=? ORDER BY rpi.rowid DESC LIMIT 1`).get(projectId) as { binding_rowid: number } | undefined;
    return row?.binding_rowid ?? null;
  }

  private exactIndex(projectId: string, envelope: ProjectIndexEnvelope): IndexRow | undefined {
    return this.db.prepare(`SELECT * FROM project_indexes
      WHERE project_id=? AND source_head=? AND tree_fingerprint=?`)
      .get(projectId, envelope.data.source_head, envelope.data.tree_fingerprint) as IndexRow | undefined;
  }

  private readJson<T>(objectId: string): T {
    try { return JSON.parse(Buffer.from(this.content.read(objectId)).toString('utf8')) as T; }
    catch (error) {
      if (isSqliteOperationalError(error)) throw error;
      throw new Error('PROJECT_INDEX_CONTEXT_INVALID');
    }
  }
}
