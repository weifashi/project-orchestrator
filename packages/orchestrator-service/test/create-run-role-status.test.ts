import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteConfigRepository } from '@project-orchestrator/sqlite-store';
import { ConfigService, LeaseService, RunService, seedBuiltins } from '../src/index.js';
import { principal, runtimeFixture, workspace } from './runtime-fixture.js';

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

function fixture() {
  const base = runtimeFixture();
  directories.push(base.dir);
  base.db.prepare("DELETE FROM projects WHERE id='project'").run();
  const repository = new SqliteConfigRepository(base.db);
  const config = new ConfigService(repository, base.content);
  seedBuiltins(config, repository);
  base.db.pragma('user_version = 1');
  const runs = new RunService(base.db, base.content, new LeaseService(base.db, 1));
  const createRun = (requestId: string) => runs.createRun({
    requestId, workflowSlug: 'bug-fix', objective: 'Fix it', runInput: {},
    principal: { ...principal, canonicalProjectPath: base.dir }, workspace,
  });
  return { ...base, config, repository, runs, createRun };
}

// 每个用例都要 seedBuiltins 播种 10 个角色和 3 个模板；首个用例还要付原生模块冷启动，
// unit 项目默认的 5s 不够用。
describe('create_run role gate', () => {
  it('accepts a workflow whose roles are all active', () => {
    const { createRun, db } = fixture();
    const result = createRun('request-ok');
    expect(db.prepare('SELECT status FROM runs WHERE id=?').get(result.runId)).toEqual({ status: 'created' });
    db.close();
  }, 30_000);

  // 主设计文档写明 disabled 角色不可用于 create_run，但这条校验此前从未实现：
  // run-service 只查 role_versions.status，不查 roles.status。
  it.each(['disabled', 'archived'] as const)('refuses a workflow that uses a %s role', (status) => {
    const { createRun, db, repository } = fixture();
    const research = repository.listRoles().find((role) => role.slug === 'research')!;
    repository.setRoleStatus(research.id, status);

    expect(() => createRun('request-blocked')).toThrow(new RegExp(`POLICY_VIOLATION: ${status} role research`));
    expect(db.prepare('SELECT count(*) AS count FROM runs').get()).toEqual({ count: 0 });
    db.close();
  }, 30_000);

  it('refuses a workflow that uses a removed role', () => {
    const { config, createRun, db, repository } = fixture();
    const research = repository.listRoles().find((role) => role.slug === 'research')!;
    config.removeRole(research.id);

    expect(() => createRun('request-removed')).toThrow(/POLICY_VIOLATION: removed role research/);
    db.close();
  }, 30_000);

  it('leaves an existing Run alone when its role is disabled afterwards', () => {
    const { createRun, db, repository } = fixture();
    const created = createRun('request-first');
    const research = repository.listRoles().find((role) => role.slug === 'research')!;
    repository.setRoleStatus(research.id, 'disabled');

    // 已有 Run 走冻结快照，不重跑角色校验；只有新 Run 被挡。
    expect(db.prepare('SELECT status FROM runs WHERE id=?').get(created.runId)).toEqual({ status: 'created' });
    expect(db.prepare('SELECT count(*) AS count FROM stage_runs WHERE run_id=?').get(created.runId))
      .not.toEqual({ count: 0 });
    expect(() => createRun('request-second')).toThrow(/POLICY_VIOLATION/);
    db.close();
  }, 30_000);
});
