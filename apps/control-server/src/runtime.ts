import { rmSync } from 'node:fs';
import type { Server } from 'node:net';
import { ContentStore } from '@project-orchestrator/content-store';
import {
  ConfirmationService,
  invalidateRunConfirmations,
  LeaseService,
  OperationService,
  RunService,
} from '@project-orchestrator/orchestrator-service';
import {
  EventRepository,
  migrate,
  openDatabase,
} from '@project-orchestrator/sqlite-store';
import type Database from 'better-sqlite3';
import { loadConfig, type ControlConfig } from './config.js';
import { buildWebListener, type WebListener } from './http/web-listener.js';
import { closeAgentListener, startAgentListener } from './ipc/agent-listener.js';
import { createControlDispatcher } from './ipc/control-dispatcher.js';
import { OperationHelperClient } from './ipc/operation-helper-client.js';
import { createCredentialAuthenticator } from './ipc/principal.js';
import { databaseIdentity, runtimeVersion } from './version.js';

export type ControlRuntime = Readonly<{
  db: Database.Database;
  web: WebListener;
  agent: Server;
  serverEpoch: number;
  shutdown: () => Promise<void>;
}>;

type InterruptibleRun = { id: string; status: string };
const RUNTIME_APPLICATION_ID = 0x504f5243;
const MAX_SQLITE_HEADER_INTEGER = 0x7fffffff;

export function assertRuntimeDatabaseIdentity(db: Database.Database): void {
  const applicationId = db.pragma('application_id', { simple: true }) as number;
  if (applicationId !== 0 && applicationId !== RUNTIME_APPLICATION_ID) {
    throw new Error('DATABASE_APPLICATION_ID_MISMATCH');
  }
}

function interruptRuns(
  db: Database.Database,
  events: EventRepository,
  runs: readonly InterruptibleRun[],
  reason: 'server_restart' | 'lease_expired',
  now: string,
): number {
  let interrupted = 0;
  for (const run of runs) {
    invalidateRunConfirmations(db, run.id, now);
    const stages = db.prepare("SELECT id FROM stage_runs WHERE run_id=? AND status IN ('running','waiting_for_user') ORDER BY stage_key,id")
      .all(run.id) as Array<{ id: string }>;
    for (const stage of stages) {
      db.prepare("UPDATE stage_attempts SET status='interrupted',completed_at=? WHERE stage_run_id=? AND status='running'")
        .run(now, stage.id);
      db.prepare("UPDATE stage_runs SET status='interrupted',updated_at=? WHERE id=? AND status IN ('running','waiting_for_user')")
        .run(now, stage.id);
      events.append(run.id, 'stage_interrupted', 'system', { reason }, stage.id);
    }
    const changed = db.prepare(`UPDATE runs SET status='interrupted',lease_token_hash=NULL,lease_expires_at=NULL,
      lease_holder_session_id=NULL,updated_at=? WHERE id=? AND status IN ('running','waiting_for_user')`)
      .run(now, run.id);
    if (changed.changes === 1) {
      events.append(run.id, 'run_interrupted', 'system', { previousStatus: run.status, reason });
      interrupted += 1;
    }
  }
  return interrupted;
}

export function prepareRuntimeStartup(db: Database.Database): number {
  const events = new EventRepository(db);
  return db.transaction(() => {
    assertRuntimeDatabaseIdentity(db);
    const applicationId = db.pragma('application_id', { simple: true }) as number;
    if (applicationId === 0) db.pragma(`application_id = ${RUNTIME_APPLICATION_ID}`);
    const storedEpoch = db.pragma('user_version', { simple: true }) as number;
    const runEpoch = db.prepare('SELECT COALESCE(MAX(server_epoch),0) AS value FROM runs').get() as { value: number };
    const serverEpoch = Math.max(storedEpoch, runEpoch.value) + 1;
    if (serverEpoch > MAX_SQLITE_HEADER_INTEGER) throw new Error('SERVER_EPOCH_EXHAUSTED');
    db.pragma(`user_version = ${serverEpoch}`);
    const now = new Date().toISOString();
    const activeRuns = db.prepare("SELECT id,status FROM runs WHERE status IN ('running','waiting_for_user') ORDER BY id")
      .all() as Array<{ id: string; status: string }>;
    const operations = db.prepare("SELECT id,run_id FROM side_effect_operations WHERE status='executing' ORDER BY run_id,id")
      .all() as Array<{ id: string; run_id: string }>;
    for (const operation of operations) {
      db.prepare("UPDATE side_effect_operations SET status='unknown',completed_at=? WHERE id=? AND status='executing'")
        .run(now, operation.id);
      events.append(operation.run_id, 'side_effect_unknown', 'system', { operationId: operation.id, reason: 'server_restart' });
    }
    interruptRuns(db, events, activeRuns, 'server_restart', now);
    return serverEpoch;
  }).immediate();
}

export function interruptExpiredLeases(db: Database.Database, now = new Date()): number {
  return db.transaction(() => {
    const runs = db.prepare(`SELECT id,status FROM runs WHERE status IN ('running','waiting_for_user')
      AND lease_expires_at IS NOT NULL AND lease_expires_at<=? ORDER BY id`)
      .all(now.toISOString()) as InterruptibleRun[];
    return interruptRuns(db, new EventRepository(db), runs, 'lease_expired', now.toISOString());
  }).immediate();
}

export async function startControlServer(config: ControlConfig = loadConfig()): Promise<ControlRuntime> {
  const db = openDatabase(config.databasePath);
  try {
    assertRuntimeDatabaseIdentity(db);
  } catch (error) {
    db.close();
    throw error;
  }
  const operationHelper = new OperationHelperClient(config.operationSocketPath);
  try {
    await operationHelper.ping();
  } catch (error) {
    db.close();
    throw error;
  }
  migrate(db);
  const content = new ContentStore(config.objectsPath, db);
  for (const row of db.prepare('SELECT id FROM content_objects').all() as Array<{ id: string }>) content.verify(row.id);
  const serverEpoch = prepareRuntimeStartup(db);
  const leases = new LeaseService(db, serverEpoch);
  const runs = new RunService(db, content, leases);
  const confirmations = new ConfirmationService(db, undefined, content);
  const operations = new OperationService(
    db, content, leases, confirmations, operationHelper,
  );
  const dispatcher = createControlDispatcher({ db, runs, leases, confirmations, operations });
  const agent = await startAgentListener({
    socketPath: config.controlSocketPath,
    authenticate: createCredentialAuthenticator(db),
    maxFrameBytes: config.maxFrameBytes,
    dispatch: dispatcher.dispatch,
    submitConfirmation: dispatcher.submitConfirmation,
  });
  const web = buildWebListener({
    db, content, sessionSecret: config.webSessionSecret, allowedOrigins: config.allowedOrigins, lanOrigins: config.lanOrigins,
    ...(config.allowedHosts === undefined ? {} : { allowedHosts: config.allowedHosts }),
    ...(config.staticDirectory === undefined ? {} : { staticDirectory: config.staticDirectory }),
    healthIdentity: {
      version: runtimeVersion(),
      databaseId: databaseIdentity(config.databasePath),
      operationsReady: async () => {
        try { await operationHelper.ping(); return true; } catch { return false; }
      },
    },
  });
  try {
    await web.listen({ host: config.webHost, port: config.webPort });
  } catch (error) {
    await closeAgentListener(agent);
    db.close();
    rmSync(config.controlSocketPath, { force: true });
    throw error;
  }
  const leaseSweep = setInterval(() => {
    confirmations.expireDue();
    interruptExpiredLeases(db);
  }, 1_000);
  let closing: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    closing ??= (async () => {
      clearInterval(leaseSweep);
      await closeAgentListener(agent);
      web.closeEventStreams();
      await web.close();
      db.close();
      rmSync(config.controlSocketPath, { force: true });
    })();
    return closing;
  };
  return Object.freeze({ db, web, agent, serverEpoch, shutdown });
}
