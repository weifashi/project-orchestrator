import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ContentStore } from '@project-orchestrator/content-store';
import { ConfigService, seedBuiltins } from '@project-orchestrator/orchestrator-service';
import { SqliteConfigRepository, migrate, openDatabase } from '@project-orchestrator/sqlite-store';

describe('foundation integration', () => {
  it('persists seeded contracts through SQLite and CAS', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orchestrator-integration-'));
    try {
      const db = openDatabase(join(directory, 'store.sqlite'));
      migrate(db);
      const repository = new SqliteConfigRepository(db);
      const content = new ContentStore(join(directory, 'objects'), db);
      const service = new ConfigService(repository, content);
      seedBuiltins(service, repository);
      for (const template of service.listPublishedTemplates()) content.verify(template.contentObjectId);
      expect(service.listPublishedTemplates()).toHaveLength(3);
      db.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
