import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ContentStore } from '@project-orchestrator/content-store';
import { SqliteConfigRepository, migrate, openDatabase } from '@project-orchestrator/sqlite-store';
import { ConfigService, seedBuiltins } from '../src/index.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

function fixture(seed = false) {
  const directory = mkdtempSync(join(tmpdir(), 'role-lifecycle-'));
  directories.push(directory);
  const db = openDatabase(join(directory, 'store.sqlite'));
  migrate(db);
  const repository = new SqliteConfigRepository(db);
  const content = new ContentStore(join(directory, 'objects'), db);
  const service = new ConfigService(repository, content);
  if (seed) seedBuiltins(service, repository);
  return { db, repository, content, service };
}

const newRole = {
  slug: 'release-notes',
  displayName: 'Release Notes',
  responsibilities: ['Summarise the release'],
  requestedCapabilities: ['read-workspace'],
};

describe('creating a custom role', () => {
  it('publishes v1 so the role is immediately usable', () => {
    const { repository, service } = fixture();
    const created = service.createRole(newRole);

    expect(created.slug).toBe('release-notes');
    expect(created.version.versionNumber).toBe(1);
    const role = repository.getRole(created.roleId);
    expect(role?.currentVersionId).toBe(created.version.id);
    expect(role?.status).toBe('active');
    expect(role?.removedAt).toBeUndefined();
  });

  it('drops capabilities outside the platform allowlist', () => {
    const { repository, service } = fixture();
    const created = service.createRole({
      ...newRole,
      requestedCapabilities: ['read-workspace', 'not-a-real-capability'],
    });

    const published = repository.getPublishedRole(created.version.id);
    expect(published?.requestedCapabilities).toContain('not-a-real-capability');
    expect(published?.effectiveCapabilities).toEqual(['read-workspace']);
  });

  it('refuses a capability the platform never grants', () => {
    const { service } = fixture();
    expect(() => service.createRole({ ...newRole, requestedCapabilities: ['production-shell'] }))
      .toThrow(/POLICY_VIOLATION/);
  });

  it.each(['Release-Notes', '1role', 'release notes', '-release', ''])('rejects invalid slug %j', (slug) => {
    const { service } = fixture();
    expect(() => service.createRole({ ...newRole, slug })).toThrow(/CONFIG_INVALID/);
  });

  it('rejects a duplicate slug and points at restore when the twin was removed', () => {
    const { service } = fixture();
    const created = service.createRole(newRole);
    expect(() => service.createRole(newRole)).toThrow(/already exists/);

    service.removeRole(created.roleId);
    expect(() => service.createRole(newRole)).toThrow(/restore it instead/);
  });

  it('requires at least one responsibility', () => {
    const { service } = fixture();
    expect(() => service.createRole({ ...newRole, responsibilities: [] })).toThrow(/CONFIG_INVALID/);
  });
});

describe('removing a role', () => {
  it('keeps the row so history and the version survive', () => {
    const { repository, service } = fixture();
    const created = service.createRole(newRole);

    expect(service.removeRole(created.roleId)).toEqual({ removed: true });
    const role = repository.getRole(created.roleId);
    expect(role?.removedAt).toBeTypeOf('string');
    expect(repository.getPublishedRole(created.version.id)?.roleRemoved).toBe(true);
  });

  // 这条是防诈尸回归测试：一旦 listRoles() 开始过滤已移除角色，
  // seedBuiltins 会在下次启动时把它们全部重建。
  it('still appears in listRoles so seedBuiltins does not recreate it', () => {
    const { repository, service } = fixture();
    const created = service.createRole(newRole);
    service.removeRole(created.roleId);

    expect(repository.listRoles().map((role) => role.slug)).toContain('release-notes');
  });

  it('leaves status untouched, so restoring does not silently re-enable', () => {
    const { repository, service } = fixture();
    const created = service.createRole(newRole);
    repository.setRoleStatus(created.roleId, 'disabled');

    service.removeRole(created.roleId);
    service.restoreRole(created.roleId);

    expect(repository.getRole(created.roleId)?.status).toBe('disabled');
  });

  it('is idempotent in both directions', () => {
    const { service } = fixture();
    const created = service.createRole(newRole);

    expect(service.removeRole(created.roleId)).toEqual({ removed: true });
    expect(service.removeRole(created.roleId)).toEqual({ removed: false });
    expect(service.restoreRole(created.roleId)).toEqual({ restored: true });
    expect(service.restoreRole(created.roleId)).toEqual({ restored: false });
  });

  it('refuses to publish a new version while removed', () => {
    const { service } = fixture();
    const created = service.createRole(newRole);
    service.removeRole(created.roleId);

    expect(() => service.publishRole({
      roleId: created.roleId,
      envelope: {
        schema_id: 'project-orchestrator/role-version', schema_version: 1,
        data: {
          slug: 'release-notes', display_name: 'Release Notes', responsibilities: ['Again'],
          requested_capabilities: [], forbidden_capabilities: [],
          input_schema: { schema_id: 'a/input', schema_version: 1, data: {} },
          output_schema: { schema_id: 'a/output', schema_version: 1, data: {} },
          completion_contract: { schema_id: 'a/completion', schema_version: 1, data: {} },
          body_markdown: '# Role',
        },
      },
    })).toThrow(/was removed/);
  });

  it('reports NOT_FOUND for an unknown role', () => {
    const { service } = fixture();
    expect(() => service.removeRole('nope')).toThrow(/NOT_FOUND/);
    expect(() => service.restoreRole('nope')).toThrow(/NOT_FOUND/);
  });
});

describe('built-in roles', () => {
  it('are not recreated by a later seed run once removed', () => {
    const { repository, service } = fixture(true);
    const testing = repository.listRoles().find((role) => role.slug === 'testing');
    service.removeRole(testing!.id);

    // 模拟重启：服务每次启动都会再播种一次。
    seedBuiltins(service, repository);

    expect(repository.getRole(testing!.id)?.removedAt).toBeTypeOf('string');
    expect(repository.listRoles().filter((role) => role.slug === 'testing')).toHaveLength(1);
  });

  it('reset back to the factory definition as a new version', () => {
    const { repository, service } = fixture(true);
    const testing = repository.listRoles().find((role) => role.slug === 'testing')!;
    service.removeRole(testing.id);
    repository.setRoleStatus(testing.id, 'disabled');

    const version = service.resetRoleToBuiltin(testing.id);

    expect(version.versionNumber).toBe(2);
    const role = repository.getRole(testing.id);
    expect(role?.removedAt).toBeUndefined();
    expect(role?.status).toBe('active');
    expect(role?.currentVersionId).toBe(version.id);
    // 历史版本保持不变
    expect(repository.getPublishedRole(version.id)?.versionNumber).toBe(2);
  });

  it('refuse a factory reset for a custom role', () => {
    const { service } = fixture();
    const created = service.createRole(newRole);
    expect(() => service.resetRoleToBuiltin(created.roleId)).toThrow(/no built-in definition/);
  });
});

describe('workflow publication', () => {
  it('rejects a template stage that references a removed role', () => {
    const { content, repository, service } = fixture(true);
    const research = repository.listRoles().find((role) => role.slug === 'research')!;
    service.removeRole(research.id);

    const template = repository.listWorkflowTemplates().find((item) => item.slug === 'bug-fix')!;
    const published = service.listPublishedTemplates().find((item) => item.slug === 'bug-fix')!;
    const envelope = JSON.parse(
      Buffer.from(content.read(published.contentObjectId)).toString('utf8'),
    ) as { data: { version: number } };
    envelope.data.version = 2;

    expect(() => service.publishWorkflow({ workflowTemplateId: template.id, envelope }))
      .toThrow(/removed role research/);
  });
});
