import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ContentStore } from '@project-orchestrator/content-store';
import type { MemoryRetentionPolicy, MemoryScope, MemoryType } from '@project-orchestrator/contracts';

const REDACTED = '[REDACTED]';
const SENSITIVE_KEY = /(?:password|passwd|passphrase|secret|token|credential|authorization|cookie|privatekey|apikey|accesskey|sessionkey)/i;

function redactString(value: string): string {
  return value
    .replace(/(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`)
    .replace(/\b(password|passwd|passphrase|secret|token|credential|api[_-]?key|access[_-]?key)\b\s*[:=]\s*[^\s,;]+/gi,
      (_match, key: string) => `${key}: ${REDACTED}`);
}

export function redactMemoryContent(value: unknown): unknown {
  const active = new WeakSet<object>();
  const visit = (candidate: unknown): unknown => {
    if (typeof candidate === 'string') return redactString(candidate);
    if (candidate === null || typeof candidate === 'boolean' || typeof candidate === 'number') return candidate;
    if (Array.isArray(candidate)) {
      if (active.has(candidate)) throw new Error('SCHEMA_INVALID: cyclic memory content');
      active.add(candidate);
      const result = candidate.map(visit);
      active.delete(candidate);
      return result;
    }
    if (typeof candidate === 'object' && Object.getPrototypeOf(candidate) === Object.prototype) {
      if (active.has(candidate)) throw new Error('SCHEMA_INVALID: cyclic memory content');
      active.add(candidate);
      const result: Record<string, unknown> = {};
      for (const [key, nested] of Object.entries(candidate as Record<string, unknown>)) {
        const normalizedKey = key.replace(/[^a-z0-9]/gi, '');
        result[key] = SENSITIVE_KEY.test(normalizedKey) ? REDACTED : visit(nested);
      }
      active.delete(candidate);
      return result;
    }
    throw new Error('SCHEMA_INVALID: memory content must be JSON');
  };
  return visit(value);
}

type FrozenRoleBundle = {
  roles?: Array<{ roleVersionId?: unknown; envelope?: { data?: { slug?: unknown } } }>;
};

export type RecordMemoryInput = Readonly<{
  runId: string;
  stageRunId: string;
  memoryType: MemoryType;
  scope: MemoryScope;
  title: string;
  summary: string;
  content: unknown;
  retentionPolicy: MemoryRetentionPolicy;
}>;

export type RecordedMemory = Readonly<{
  id: string;
  contentObjectId: string;
  deduplicated: boolean;
}>;

export class MemoryService {
  constructor(readonly db: Database.Database, readonly content: ContentStore) {}

  record(input: RecordMemoryInput): RecordedMemory {
    const work = (): RecordedMemory => {
      const stage = this.db.prepare(`SELECT s.role_version_id,s.status,r.project_id,
          rv.effective_capabilities,rs.role_bundle_object_id
        FROM stage_runs s JOIN runs r ON r.id=s.run_id
        JOIN role_versions rv ON rv.id=s.role_version_id
        JOIN run_snapshots rs ON rs.run_id=r.id
        WHERE s.id=? AND s.run_id=?`).get(input.stageRunId, input.runId) as {
          role_version_id: string;
          status: string;
          project_id: string;
          effective_capabilities: string;
          role_bundle_object_id: string;
        } | undefined;
      if (!stage) throw new Error('POLICY_VIOLATION: memory stage does not belong to run');
      if (stage.status !== 'running') throw new Error('INVALID_TRANSITION: memory stage is not running');

      let bundle: FrozenRoleBundle;
      try {
        bundle = JSON.parse(Buffer.from(this.content.read(stage.role_bundle_object_id)).toString()) as FrozenRoleBundle;
      } catch {
        throw new Error('ARTIFACT_MISSING: frozen role bundle cannot be read');
      }
      const frozenRole = bundle.roles?.find((candidate) => candidate.roleVersionId === stage.role_version_id);
      const frozenSlug = frozenRole?.envelope?.data?.slug;
      let effectiveCapabilities: unknown;
      try {
        effectiveCapabilities = JSON.parse(stage.effective_capabilities);
      } catch {
        throw new Error('POLICY_VIOLATION: invalid frozen role capabilities');
      }
      const explicitlyAllowed = Array.isArray(effectiveCapabilities) && effectiveCapabilities.includes('write-memory');
      if (frozenSlug !== 'memory-docs' && !explicitlyAllowed) {
        throw new Error('POLICY_VIOLATION: role cannot write memory');
      }

      const redactedContent = redactMemoryContent(input.content);
      const object = this.content.putCanonicalJson(redactedContent);
      const existing = this.db.prepare(`SELECT id,content_object_id FROM memories
        WHERE project_id=? AND memory_type=? AND content_object_id=?`)
        .get(stage.project_id, input.memoryType, object.id) as { id: string; content_object_id: string } | undefined;
      if (existing) return { id: existing.id, contentObjectId: existing.content_object_id, deduplicated: true };

      const id = randomUUID();
      this.db.prepare(`INSERT INTO memories
        (id,project_id,source_run_id,memory_type,scope,title,summary,content_object_id,retention_policy,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`)
        .run(id, stage.project_id, input.runId, input.memoryType, input.scope, redactString(input.title),
          redactString(input.summary), object.id, input.retentionPolicy, new Date().toISOString());
      return { id, contentObjectId: object.id, deduplicated: false };
    };
    return this.db.inTransaction ? work() : this.db.transaction(work).immediate();
  }
}
