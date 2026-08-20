import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type Database from 'better-sqlite3';

type MigrationRow = { version: number; checksum: string };
type DatabaseFileRow = { file: string };

function hasMigrationTable(db: Database.Database): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get() !== undefined;
}

function userTableCount(db: Database.Database): number {
  const row = db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get() as { count: number };
  return row.count;
}

function backupDatabase(db: Database.Database): void {
  const row = db.prepare('PRAGMA database_list').all().find((entry) => (entry as { name: string }).name === 'main') as DatabaseFileRow | undefined;
  if (!row?.file || row.file === ':memory:') return;
  const backupPath = `${row.file}.pre-migration-${Date.now()}.bak`;
  db.exec(`VACUUM INTO '${backupPath.replaceAll("'", "''")}'`);
}

export function migrate(
  db: Database.Database,
  migrationsDirectory = fileURLToPath(new URL('../migrations', import.meta.url)),
): void {
  const migrations = readdirSync(migrationsDirectory)
    .filter((name) => /^\d{3}_.+\.sql$/.test(name))
    .sort()
    .map((name) => {
      const match = /^(\d{3})_(.+)\.sql$/.exec(name);
      if (!match?.[1]) throw new Error(`Invalid migration filename: ${name}`);
      const sql = readFileSync(join(migrationsDirectory, name), 'utf8');
      return {
        version: Number(match[1]),
        name,
        sql,
        checksum: createHash('sha256').update(sql).digest('hex'),
      };
    });

  const applied = new Map<number, string>();
  if (hasMigrationTable(db)) {
    for (const row of db.prepare('SELECT version, checksum FROM schema_migrations').all() as MigrationRow[]) {
      applied.set(row.version, row.checksum);
    }
  }

  for (const migration of migrations) {
    const previousChecksum = applied.get(migration.version);
    if (previousChecksum !== undefined) {
      if (previousChecksum !== migration.checksum) throw new Error(`MIGRATION_CHECKSUM_MISMATCH: ${migration.name}`);
      continue;
    }

    if (userTableCount(db) > 0) backupDatabase(db);
    db.transaction(() => {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations(version,name,checksum,applied_at) VALUES(?,?,?,?)')
        .run(migration.version, migration.name, migration.checksum, new Date().toISOString());
    }).immediate();
  }
}
