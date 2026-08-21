import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { ContentStore } from '@project-orchestrator/content-store';
import { ConfigService, seedBuiltins } from '@project-orchestrator/orchestrator-service';
import { migrate, openDatabase, SqliteConfigRepository } from '@project-orchestrator/sqlite-store';

export type LocalStateInput = Readonly<{
  databasePath: string;
  objectsPath: string;
  credentialFiles: Readonly<{ codex: string; claude: string }>;
}>;

export type LocalStateInspection = Readonly<{
  ok: boolean;
  code: 'HEALTHY' | 'UNHEALTHY';
  databaseIntegrity: boolean;
  contentIntegrity: boolean;
  activeInstallations: number;
  clientInstallations: boolean;
}>;

function readCredential(path: string): string {
  const stats = lstatSync(path);
  const uid = typeof process.getuid === 'function' ? process.getuid() : stats.uid;
  if (!stats.isFile() || stats.isSymbolicLink() || stats.uid !== uid || (stats.mode & 0o077) !== 0) {
    throw new Error(`POLICY_VIOLATION: credential file permissions ${path}`);
  }
  const value = readFileSync(path, 'utf8').trim();
  if (value.length === 0) throw new Error(`CONFIG_MISSING: empty credential ${path}`);
  return value;
}

export function initializeLocalState(input: LocalStateInput): void {
  const credentials = {
    codex: readCredential(input.credentialFiles.codex),
    claude: readCredential(input.credentialFiles.claude),
  };
  if (credentials.codex === credentials.claude) throw new Error('POLICY_VIOLATION: client credentials must differ');
  const db = openDatabase(input.databasePath);
  try {
    migrate(db);
    const content = new ContentStore(input.objectsPath, db);
    seedBuiltins(new ConfigService(new SqliteConfigRepository(db), content), new SqliteConfigRepository(db));
    const now = new Date().toISOString();
    for (const clientType of ['codex', 'claude'] as const) {
      const capability = content.putCanonicalJson({
        clientType,
        adapterVersion: '0.1.3',
        trustedRootSessionIdentity: true,
        parallelSubagentIsolation: false,
        trustedInteractiveConfirmation: false,
        managedOperationExecution: true,
      });
      db.prepare(`INSERT INTO client_installations
        (id,client_type,adapter_version,capability_object_id,credential_hash,status,last_seen_at)
        VALUES(?,?,?,?,?,'active',?)
        ON CONFLICT(id) DO UPDATE SET adapter_version=excluded.adapter_version,
          capability_object_id=excluded.capability_object_id,credential_hash=excluded.credential_hash,status='active'`)
        .run(`local-${clientType}`, clientType, '0.1.3', capability.id,
          createHash('sha256').update(credentials[clientType]).digest('hex'), now);
    }
  } finally {
    db.close();
  }
}

export function inspectLocalState(input: LocalStateInput): LocalStateInspection {
  let databaseIntegrity = false;
  let contentIntegrity = false;
  let activeInstallations = 0;
  let clientInstallations = false;
  try {
    const credentials = {
      codex: readCredential(input.credentialFiles.codex),
      claude: readCredential(input.credentialFiles.claude),
    };
    const db = openDatabase(input.databasePath);
    try {
      databaseIntegrity = db.pragma('integrity_check', { simple: true }) === 'ok';
      activeInstallations = Number((db.prepare("SELECT count(*) AS count FROM client_installations WHERE status='active'").get() as { count: number }).count);
      const rows = db.prepare(`SELECT id,client_type,status,credential_hash FROM client_installations
        WHERE id IN ('local-codex','local-claude') ORDER BY id`).all() as Array<{
          id: string; client_type: string; status: string; credential_hash: string;
        }>;
      clientInstallations = (['codex', 'claude'] as const).every((clientType) => {
        const row = rows.find((candidate) => candidate.id === `local-${clientType}`);
        return row?.client_type === clientType && row.status === 'active'
          && row.credential_hash === createHash('sha256').update(credentials[clientType]).digest('hex');
      });
      const content = new ContentStore(input.objectsPath, db);
      for (const row of db.prepare('SELECT id FROM content_objects').all() as Array<{ id: string }>) content.verify(row.id);
      contentIntegrity = true;
    } finally {
      db.close();
    }
  } catch {
    // Doctor returns a stable non-secret result instead of leaking paths or credentials.
  }
  const ok = databaseIntegrity && contentIntegrity && activeInstallations === 2 && clientInstallations;
  return Object.freeze({
    ok, code: ok ? 'HEALTHY' : 'UNHEALTHY', databaseIntegrity, contentIntegrity,
    activeInstallations, clientInstallations,
  });
}
