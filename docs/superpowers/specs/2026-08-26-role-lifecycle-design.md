# 角色新建与移除设计

## 目标
角色目录从"只能编辑内置的 10 个"变成可增可减：网页能新建自定义角色，也能移除任何角色（含内置），移除后可恢复，内置角色可恢复为出厂定义。历史任务记录不因此损坏。

## 范围与边界
- 移除是墓碑式软删除，不是物理删除：`roles` 行保留，指向 `roles` / `role_versions` 的外键与 `ON DELETE RESTRICT` 全部原样不动。
- 已移除角色在网页上完全消失，不能被新流程模板引用，不能用于新 Run；已有 Run 的冻结快照继续可读、可打开。
- 移除不是安全撤销。安全撤销仍是 `role_versions.status='revoked'`，它阻止新 Run 且不可被快照绕过；移除只影响"未来是否可选"。
- 新建角色一步建全并立即发布 v1，不产生"建了却用不了"的中间态。
- 恢复内置默认不修改历史版本，而是用内置定义发布一个新版本；版本发布后不可变这条不破。
- 平台禁止能力始终优先。新建与恢复都走现有发布路径的能力求交，网页不能授予平台禁用能力，也不能降低安全基线。
- 不做第三方 Skill 市场，不做角色导入导出，不做跨项目角色共享。

## 数据模型
```text
roles
  + removed_at TEXT NULL          -- NULL=存在，非空=已移除（墓碑）
  + INDEX idx_roles_removed_at
```
迁移文件 `packages/sqlite-store/migrations/004_role_lifecycle.sql`。只加一列一索引，不改任何既有列与外键。

不新增 `origin` 列区分内置与自定义。`BUILTIN_ROLE_SLUGS` 已是代码里的唯一真源，读接口按 slug 归属计算 `is_builtin` 返回前端，避免数据库副本与代码脱节。

### 不变量：`listRoles()` 必须返回已移除角色
`seedBuiltins` 用 `listRoles().find(slug)` 判断是否重建内置角色。墓碑行仍在，它便不会复活已移除的内置角色——**`seedBuiltins` 因此无需任何改动**。

代价是 `listRoles()` 不得加"过滤已移除"的逻辑，否则内置角色会在下次重启集体重建。过滤只允许发生在读接口层。此不变量必须有回归测试守护。

## 服务端接口
```text
POST   /api/config/roles                    新建并立即发布 v1
DELETE /api/config/roles/:id                墓碑移除（写 removed_at）
POST   /api/config/roles/:id/restore        恢复（清空 removed_at）
POST   /api/config/roles/:id/reset-builtin  恢复为内置默认（仅内置 slug）
GET    /api/read/roles?include_removed=1    读取时默认过滤已移除
```

- 新建入参：`slug`、`name`、`responsibilities`、`requested_capabilities`、`input_schema`、`output_schema`、`completion_contract`。
- `slug` 校验 `^[a-z][a-z0-9-]*$`，唯一性由既有 `roles.slug UNIQUE` 兜底，冲突返回明确错误。
- 新建与恢复内置默认都复用 `ConfigService.publishRole`，能力求交与安全基线校验不另写一套。
- `reset-builtin` 对非内置 slug 返回 400。

### 移除与恢复只动 `removed_at`
移除与恢复都不修改 `roles.status`。一个 `disabled` 角色被移除再恢复后仍是 `disabled`，恢复不等于启用。两者是正交的两个维度：`status` 表示"是否可用于未来"，`removed_at` 表示"是否还出现在目录里"。

`DELETE` 与 `restore` 均幂等：对已处于目标状态的角色重复调用不报错，也不改写时间戳。

### 对已发布流程模板的影响
移除不追溯修改任何已发布的流程模板版本——版本不可变。已引用该角色的模板保持原样可读；但从该模板创建新 Run 时会在角色校验处被拒，错误信息指明是哪个角色已被移除。新的模板发布校验同样拒绝引用已移除角色。

## 移除的运行时拦截
`run-service.ts` 创建 Run 时逐个阶段校验角色版本，现有判断只看 `role_versions.status`：

```text
SELECT content_object_id,status FROM role_versions WHERE id=?
→ status !== 'published' 时抛 POLICY_VIOLATION: unavailable role
```

在此处 join `roles`，`removed_at` 非空时同样拒绝，错误信息指明角色已被移除。流程模板发布校验同样加此判断。

### 已知缺陷（本次不修）
主设计文档写明"`disabled` 角色不可用于新模板发布或 create_run"，但全仓找不到任何对 `roles.status` 的运行时校验——当前把角色停用后仍可用它创建 Run。此缺陷早于本次改动存在，不在本次范围内，单独记录待办。

## 页面与流转
```text
角色目录
  ├─ 页头「新建角色」→ 弹窗一步填全 → 发布 v1 → 跳转编辑器
  ├─ 每张角色卡「移除」→ 确认弹窗 → 卡片移入「已移除」区
  └─ 底部折叠「已移除角色」
       ├─ 「恢复」            所有已移除角色
       └─ 「恢复为内置默认」   仅内置 slug

角色编辑器
  └─ 「恢复内置版本」改名为「复制已发布版本」（修正错标签）
     真正的内置恢复移至新按钮，仅内置角色可见
```

- 新建弹窗的能力多选带"全选 / 反选"。
- 移除确认弹窗写明三件事：历史任务记录保留、可随时恢复、这不是安全撤销。
- 中文文案与 `en` 翻译同步落库，不留单语键。

### 修正错标签的依据
角色编辑器的「恢复内置版本」按钮实际调用 `api.roles.getDraft(id, true)`，即 `?source=published`；服务端只识别 `source === 'published'`，没有任何内置分支。它的真实行为是"把已发布版本复制进草稿"，与流程编辑器中同一调用的「复制已发布版本」标签一致。当前标签与行为不符，属实缺陷。

## 验收
- 迁移 004 可重复应用，校验和稳定，不破坏既有数据。
- 仓库层墓碑与恢复往返正确；`listRoles()` 仍返回已移除角色。
- 模拟重启后 `seedBuiltins` 不重建已移除的内置角色。
- 新建：slug 冲突被拒；能力求交生效，平台禁止能力无法被授予。
- 恢复为内置默认产生新版本号，历史版本不被修改。
- 已移除角色无法用于 create_run，错误信息指明原因。
- 已移除角色引用过的历史 Run 详情仍可正常打开。
- 网页覆盖新建弹窗、移除确认、已移除区恢复三条路径。
