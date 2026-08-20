# 跨 Codex / Claude 多角色项目编排系统设计

- 状态：待用户复核
- 日期：2026-08-20
- 原型：`/home/weifashi/www/project_orchestrator/index.html`
- 首版平台：Linux、macOS
- 首版 Agent：Codex、Claude

## 1. 摘要

本项目建设一套本机运行、业务逻辑自主开发的项目研发编排系统。它把“需求、调查、架构、UI、开发、审查、测试、安全、运维、记忆文档”固化为可配置、可追踪、可恢复的阶段流程。

真实任务只能从 Codex 或 Claude 会话启动和控制。Web 控制台只负责：

1. 编排未来运行使用的流程模板和角色版本；
2. 只读观察运行状态、事件、日志、测试证据与产物。

Web 不提供启动、暂停、恢复、取消、重试或确认 Run 的 API 与按钮。运行状态、模板、角色、快照、事件和产物索引保存在本机 SQLite；不可变 Skill、规则和证据正文保存在本机内容寻址存储（CAS），由 SQLite 保存对象索引与哈希。两者共同构成权威数据。常驻服务在用户登录后自动启动，只监听本机回环地址。

## 2. 已确认决策

| 主题 | 决策 |
|---|---|
| 自主性 | 编排业务、流程引擎、角色协议、Web 和数据模型自主开发；允许使用开源基础库，不依赖第三方编排 SaaS |
| 客户端 | 首版支持 Codex 与 Claude，公共协议预留其他 Agent 适配器 |
| Web 定位 | 只编排模板/角色、只读观察 Run，不负责执行控制 |
| 执行入口 | 只能从 Codex 或 Claude 会话启动 |
| 数据 | 本机 SQLite 是配置、索引与运行状态的唯一可信来源；不可变大内容由本机 CAS 保存并受 SQLite 索引 |
| 服务 | 本机常驻，用户登录后自动启动，只监听 `127.0.0.1`；不是操作系统内核启动阶段运行 |
| 操作系统 | 首版支持 Linux 与 macOS，Windows 延后 |
| 跨客户端 | 首版从哪个客户端启动，就由哪个客户端继续该 Run；不支持中途跨客户端接管 |
| 会话关闭 | 当前执行停止推进并记录为中断；常驻服务和 Web 继续可用；同一客户端安装实例的新会话可凭恢复凭证恢复 |
| 危险操作 | 通过本系统受控执行器执行、或要计入合法 Run 结果的删除、生产发布、不可逆迁移等，必须在 Agent 会话中人工确认 |

## 3. 目标与非目标

### 3.1 目标

- 用流程模板约束阶段顺序、依赖、并行、进入条件、退出条件和失败策略。
- 用独立角色 Skill 描述每个角色“怎么做”，避免一个大提示词承担全部职责。
- 为每个角色定义输入、输出、允许工具、禁止操作和完成契约。
- 每次启动 Run 时冻结模板、角色和关键配置，保证运行可复现。
- 让 Codex 与 Claude 使用同一套公共流程和角色语义。
- 保存阶段状态、事件、产物、人工确认证据、项目记忆和失败原因。
- 支持 Agent 会话中断后的安全恢复，不重复执行已提交的阶段动作。
- 提供清晰的本机 Web 编排和只读观察页面。

### 3.2 首版非目标

- 不做云端服务、公网访问、多租户、多人协作或 RBAC。
- 不支持从 Web 启动或控制 Run。
- 不支持 Web 确认危险操作。
- 不支持 Codex 和 Claude 混合执行同一个 Run。
- 不支持关闭 Agent 后继续自动修改代码。
- 不支持无人确认的生产部署。
- 不建设第三方 Skill 市场。
- 不支持 Windows。

## 4. 核心概念

### 4.1 角色与阶段分离

**角色**是能力定义，例如“项目调查”；**阶段**是流程中的一次工作安排，例如“新项目模板中的调查阶段”。同一个角色可被不同模板复用，一个阶段只能引用一个已发布角色版本。

### 4.2 草稿、版本与快照

- `WorkflowTemplate`：流程身份，如“标准新项目流程”。
- `WorkflowDraft`：Web 可修改的草稿，带乐观锁修订号。
- `WorkflowVersion`：发布后不可变的模板版本。
- `Role`：角色身份，如 `project-research`。
- `RoleDraft`：Web 可修改的角色草稿。
- `RoleVersion`：发布后不可变的角色内容与权限契约版本。
- `RunSnapshot`：启动 Run 时冻结的模板、角色、规则、安全基线、Adapter 能力和工作区指纹。
- `Run`：一次真实项目执行。
- `StageRun`：Run 中某一轮的逻辑阶段；非返工阶段固定 `iteration_number=0`，返工阶段按轮次递增，并以 `run_id + stage_key + iteration_number` 唯一。
- `StageAttempt`：一个阶段的一次执行尝试；重试会新增 Attempt，不覆盖历史。

Web 修改草稿不会影响任何 Run。发布时服务端验证 DAG、角色引用和不可降级安全基线；发布成功后生成不可变版本。运行中的 Run 只读取自己的快照。

### 4.3 角色内容的权威来源

内置 Skill 源码随代码库发布，用于初次安装。安装器把每个已发布角色版本的规范化 Markdown、Schema、权限契约和元数据写入本机 CAS，并在 SQLite 建立 `role_versions` 索引。Web 修改角色时编辑 `RoleDraft`；发布后产生新的不可变 CAS 对象。

运行时总控 Skill 从 RunSnapshot 读取角色内容并注入角色任务，不依赖当前插件目录中的可变文件。因此：

- 调整角色后不需要重新安装 Adapter；
- 历史 Run 即使原 Skill 文件被修改或删除也能恢复；
- Codex/Claude 插件中的固定入口 Skill 只负责发现、总控与接入，动态角色版本由 Control Server 提供。

### 4.4 产物优先的交接

角色之间不传递整段聊天记录，只传递结构化摘要和不可变产物引用。子角色不能直接写 Run 状态；它只把结构化结果返回根编排会话，由持有 Run 租约的根会话提交。

```text
stage_input
  ├─ run_id
  ├─ stage_run_id
  ├─ stage_key
  ├─ project_root
  ├─ objective
  ├─ applicable_rule_objects
  ├─ prerequisite_artifacts
  ├─ constraints
  └─ expected_outputs

stage_output
  ├─ status
  ├─ summary
  ├─ artifact_objects
  ├─ changed_file_manifest
  ├─ evidence_objects
  ├─ risks
  └─ next_stage_notes
```

所有 JSON 契约统一使用 `{schema_id, schema_version, data}` 信封，历史记录始终按写入时 Schema 解释。

## 5. 总体架构

```text
codex_plugin                       claude_plugin
  ├─ skills/                         ├─ skills/
  ├─ .mcp.json                       ├─ agents/
  └─ adapter                         ├─ .mcp.json
             \                       └─ adapter
              \                         /
               └── MCP stdio / local IPC ─┘
                          │
                          ▼
              project_orchestratord
                ├─ workflow_engine
                ├─ role_registry
                ├─ artifact_service
                ├─ memory_service
                ├─ event_store
                ├─ confirmation_service
                ├─ operation_executor
                └─ safety_baseline
                    │         │
                    ▼         ▼
             orchestrator.db  local_web
                 SQLite       arrange + observe
```

### 5.1 组件职责

| 组件 | 职责 |
|---|---|
| 公共 Skills | 角色方法、检查清单、输入输出契约和触发描述 |
| 总控 Skill | 说明如何读取编排上下文、推进阶段、调用角色并交接产物 |
| Codex Adapter | Codex 插件打包、MCP 接入、客户端身份和会话上下文转换 |
| Claude Adapter | Claude 插件打包、Agents/Skills/MCP 接入和会话上下文转换 |
| Control Server | 唯一状态写入者；状态机、版本、快照、事件、产物和恢复 |
| Web Console | 模板/角色编排、Run/事件/产物只读观察、系统诊断 |
| SQLite | 配置、运行状态、审计和产物索引的唯一可信来源 |
| Content-addressed Object Store | 保存不可变 Skill、规则、快照附件和证据正文；SQLite 存索引与哈希 |
| Operation Executor | 使用受控凭据执行动作哈希绑定的危险副作用，并回写结果 |

### 5.2 通信边界

- Codex/Claude Host 只连接各自插件随附的本机 **stdio MCP Adapter**。
- MCP Adapter 通过权限为 `0600` 的 Unix domain socket 连接常驻 Control Server；首版不向 Agent 暴露 HTTP 写入口。
- Web 只通过 `127.0.0.1` HTTP 访问独立的 Web listener，并使用不同的 Web principal。
- Agent 与 Web 的 listener、凭证、principal 和 capability 均分离；未匹配能力默认拒绝。
- Windows 延后，因此首版无需命名管道传输；未来 Adapter 接口保留传输抽象。

### 5.3 推荐源码结构

```text
project-orchestrator/
  ├─ apps/
  │  ├─ control-server/
  │  └─ web-console/
  ├─ packages/
  │  ├─ workflow-engine/
  │  ├─ contracts/
  │  ├─ role-runtime/
  │  ├─ artifact-store/
  │  ├─ memory-store/
  │  ├─ operation-executor/
  │  └─ sqlite-store/
  ├─ skills/
  │  ├─ orchestrator/
  │  ├─ requirements/
  │  ├─ research/
  │  ├─ architecture/
  │  ├─ ui-design/
  │  ├─ implementation/
  │  ├─ code-review/
  │  ├─ testing/
  │  ├─ security/
  │  ├─ operations/
  │  └─ memory-docs/
  ├─ adapters/
  │  ├─ codex/
  │  └─ claude/
  ├─ schemas/
  ├─ migrations/
  ├─ installer/
  │  ├─ linux/
  │  └─ macos/
  ├─ tests/
  └─ docs/
```

## 6. 一次 Run 的完整数据流

```text
1. 用户在 Web 编辑并发布模板/角色版本
2. 用户在 Codex 或 Claude 输入“按新项目流程开始”
3. Adapter 向 Control Server 查询适用的已发布模板
4. Agent 展示关键配置并在会话中确认启动意图
5. Adapter 调用 create_run
6. Control Server 原子写入 Run + RunSnapshot + StageRuns
7. 总控 Skill 获取全部 ready 阶段；可并行阶段由根会话分派子角色
8. 子角色只向根会话返回结构化结果；根会话以当前 Run 租约提交 StageAttempt
9. Control Server 校验产物、退出条件、安全基线和幂等键，原子冻结 Attempt 结果并推进 DAG
10. Web 通过 SSE 只读接收事件与快照
11. 遇到确认点时，Agent 会话询问用户并记录确认结果
12. 全部阶段完成后生成交付摘要与项目记忆
```

### 6.1 新项目标准流程

```text
requirements
    │ user confirmation
    ▼
research
    ├─────────────┐
    ▼             ▼
architecture    ui_design
    └──────┬──────┘
           ▼
implementation
    ├──────────┬──────────┐
    ▼          ▼          ▼
code_review  testing    security
    └──────────┼──────────┘
          failed finding
               └────→ implementation → review/test/security again
               │ release confirmation in agent session
               ▼
operations
    ▼
memory_docs
```

### 6.2 内置模板

1. **新项目**：走完整链路；架构阶段同时交付实施计划，审查/测试/安全任一失败均回到实现阶段，默认最多返工 3 轮，超过后 Run 失败并保留证据。
2. **功能开发**：始终执行调查、实现、审查和测试；API/Schema/模块边界变化时启用架构，用户可见变化时启用 UI，涉及权限/秘密/外部输入/依赖时启用安全，涉及运行时、迁移或发布物时启用运维。
3. **Bug 修复**：始终执行复现调查、最小修复、审查、回归测试和记忆；仅在根因改变模块边界时启用架构，用户可见行为变化时启用 UI，安全敏感时启用安全，需要发布/迁移时启用运维。

## 7. 首版角色设计

| 角色 | 主要输入 | 必须输出 | 关键边界 |
|---|---|---|---|
| 需求分析 | 用户想法、现有约束 | 需求确认单、验收标准 | 不能替用户确认需求 |
| 项目调查 | 项目目录、规则、需求 | 调查报告、未知项 | 不能没读现有实现就设计 |
| 架构设计 | 需求、调查报告 | 架构说明、ADR、数据/接口设计、实施计划 | 不直接实施或部署 |
| UI/交互设计 | 需求、调查、设计规范 | HTML 原型、状态与操作结果 | 用户确认前不进入开发实现 |
| 开发实现 | 设计、实施计划、规则 | 代码变更、变更清单 | 不能自己宣布测试通过 |
| 代码审查 | Diff、需求、规则 | 逐行审查、风险与影响面 | 不代替业务验收 |
| 自动化测试 | 需求、Diff、运行环境 | 命令、原始输出、测试证据 | 独立验证，不接受口头“已测” |
| 安全检查 | 权限、秘密、外部输入、Diff | 安全风险和处理结论 | 不能自行降低危险操作级别 |
| 构建运维 | 已验证代码、发布信息 | 构建、部署、冒烟、回滚记录 | 生产操作必须会话确认 |
| 记忆文档 | 全部已审计产物 | 决策、规则、交付和经验归档 | 写入前去重、分层和脱敏 |

角色 Skill 采用公共 Agent Skills 目录结构；Claude 专有 Agent 定义和 Codex 专有元数据由各自 Adapter 生成，不污染公共角色语义。

## 8. 状态机与执行所有权

### 8.1 单写者与并行阶段

一个 Run 只有根编排会话可以持有 Run 租约。并行子角色可以同时工作，但不能直接写 Control Server；它们把结果返回根会话，由根会话依次提交。Run 不保存可写的单值 `current_stage_key`，Web 展示的“当前阶段集合”由 `stage_runs` 推导。

Lease token 永不进入模型上下文或工具参数 Schema，由本机 Adapter 保管并自动附加。Adapter 必须通过 Host 的可信会话标识确认调用来自根会话；子 Agent 的工具集合移除全部编排写工具。若 Host 无法证明根/子会话隔离，capability check 自动关闭并行，全部角色由根会话串行执行。

```text
root orchestration session      owns run lease
  ├─ research subagent          returns result only
  ├─ architecture subagent      returns result only
  ├─ ui subagent                returns result only
  └─ test subagent              returns result only
             │
             ▼
root session serializes validated writes
```

### 8.2 Run 状态转换

| 当前状态 | 事件 | 目标状态 | 守卫与事务副作用 |
|---|---|---|---|
| 无 | `create_run` | `created` | 客户端已认证；模板已发布；原子创建快照和逻辑 StageRun |
| `created` | `claim_run` | `running` | 同一客户端安装实例；签发 lease token、`lease_epoch=1` 和恢复凭证 |
| `running` | `request_confirmation` 且无其他可运行阶段 | `waiting_for_user` | 服务端创建一次性 ConfirmationRequest；可运行并行阶段已为空 |
| `waiting_for_user` | `submit_confirmation(approve)` | `running` | 决定来自可信 Adapter 交互；challenge、动作哈希和有效期匹配 |
| `waiting_for_user` | `submit_confirmation(reject)` | `paused` 或 `cancelled` | 按快照中的确认策略处理并记录原因 |
| `running`/`waiting_for_user` | `pause_run` | `paused` | 释放执行租约；不终止已产生的外部副作用 |
| `paused` | `claim_run(resume)` | `running` | 同一客户端安装实例；恢复校验通过；签发新 `lease_epoch` |
| `running`/`waiting_for_user` | 心跳过期或进程失联 | `interrupted` | 已过期租约失效；未完成 Attempt 标为中断 |
| `interrupted` | `claim_run(recover)` | `running` | 恢复凭证、工作区指纹和能力校验通过；签发新 epoch |
| `running` | 任一不可继续的阶段失败且无其他可运行阶段 | `failed` | 保存失败、证据和 `is_retryable`；释放租约 |
| `failed` | `claim_run(mode=retry, stage_run_id)` | `running` | 仅 `is_retryable=true`；目标 StageRun 必须 failed/interrupted；原子领取新 lease、创建 Attempt，并把 StageRun/Run 都转 running |
| 非终态 | `cancel_run` | `cancelled` | Agent 会话明确请求；冻结未完成阶段；释放租约 |
| `running` | `finalize_run` | `completed` | 服务端重新计算：全部必需阶段、确认、安全门和产物契约均满足 |

`completed`、`cancelled` 为终态。`failed` 只有 `is_retryable=true` 时允许 `claim_run(mode=retry)`；不可重试失败保持终止。

### 8.3 StageRun 与 StageAttempt

`StageRun` 是逻辑阶段，状态为：`queued`、`ready`、`running`、`waiting_for_user`、`succeeded`、`failed`、`skipped`、`cancelled`、`interrupted`。

| 当前状态 | 事件 | 目标状态 | 规则 |
|---|---|---|---|
| `queued` | 所有依赖满足且条件为真 | `ready` | 由服务端 DAG 求值器派生 |
| `queued` | 条件为假 | `skipped` | 仅普通可选阶段；mandatory gate 不可跳过 |
| `ready` | `begin_stage` | `running` | 新增 StageAttempt，attempt number 递增 |
| `running` | `complete_stage` | `succeeded` | 同事务校验并冻结输出、Artifact/Evidence manifest 与哈希 |
| `running` | `fail_stage` | `failed` | 冻结本次 Attempt 失败证据 |
| `running` | 需要用户确认 | `waiting_for_user` | 创建 ConfirmationRequest；不接受自由文本“已批准” |
| `waiting_for_user` | 确认通过 | `running` | 消费一次性决定后继续当前 Attempt |
| `running`/`waiting_for_user` | Run 中断 | `interrupted` | 当前 Attempt 保留，恢复后新增 Attempt |
| `failed`/`interrupted` | `retry_stage` | `running` | 新增 Attempt；旧 Attempt 不覆盖 |
| `queued`/`ready` | `skip_stage` | `skipped` | 只有快照声明为 optional 且安全策略允许 |
| 非终态 | Run 取消 | `cancelled` | 随 Run 原子取消 |

`StageAttempt.status` 只允许 `running`、`succeeded`、`failed`、`interrupted`：由 `begin_stage` 创建为 running；`complete_stage` 转 succeeded；`fail_stage` 转 failed；租约失效转 interrupted。Attempt 一旦离开 running 就不可修改。

确认被拒绝时，当前 Attempt 以 `USER_REJECTED` 失败；阶段按快照策略让 Run 进入 `paused` 或 `cancelled`。重新请求确认必须创建新的 ConfirmationRequest，不复用旧决定。

### 8.4 有界返工 iteration

返工不重新打开旧的 succeeded StageRun。模板单独定义 `WorkflowIterationGroup`，首版新项目包含 `delivery_loop`：入口为 implementation，gate 为 code_review/testing/security，聚合策略为 `collect_all`，最大 3 轮。

- 一轮开始时为组内每个阶段创建带相同 `iteration_number` 的新 StageRun。
- 三个 gate 全部完成后再汇总 findings；任一 gate 失败则本轮 failed。
- 未超过上限时创建下一轮 implementation 与全部 gate StageRun，旧轮证据保持不变。
- operations 只依赖最新一轮 iteration succeeded；`finalize_run` 只认可最新成功轮。
- 返工关系不属于依赖 DAG，不用图上的回边表达；唯一来源是 iteration group 配置。

### 8.5 DAG 与条件 DSL

首版不接受任意脚本表达式，只支持有限 JSON DSL：

- 比较：`eq`、`ne`、`in`、`exists`；
- 逻辑：`all`、`any`、`not`；
- 可读取值：Run 启动输入、前置阶段结构化输出、模板常量；
- 不允许读取环境变量、文件或执行代码；
- 缺值或表达式错误一律 fail closed，Run 进入 `failed`；
- `edge_type` 仅允许 `requires`、`on_success`；success dependency graph 必须无环；
- mandatory gate 的依赖不可被条件边绕过。

### 8.6 租约、恢复与 fencing

- 认证 Adapter 通过 `claim_run` 获得只返回一次的 lease token；数据库只保存哈希。
- 每次领取产生单调递增 `lease_epoch`。所有 Run 写事务必须同时匹配 `run_id + lease_epoch + lease_token_hash + lease_expires_at`。
- 心跳只延长当前 epoch；旧 epoch 的延迟请求一律拒绝。
- `waiting_for_user` 期间 Adapter 继续轻量心跳；会话失联则正常转为 `interrupted`。
- 恢复凭证绑定 `client_installation_id + run_id`，数据库只存哈希；恢复成功后立即轮换。
- “原客户端”指同一客户端类型、同一本机安装实例，不要求同一个已关闭会话 ID。
- 恢复比较最后一个可信 `workspace_checkpoint`，不是永远比较 Run 启动快照。中断 Attempt 之后存在未记录工作区变化时，必须在 Agent 会话展示 Diff，由用户选择恢复原检查点或 fork 新 Run。

### 8.7 幂等与外部副作用

- 每个写命令带 `request_id`；服务端以 `principal + operation + request_id` 唯一去重。
- 同键同请求返回已保存结果；同键不同请求体拒绝。
- `StageAttempt` 使用唯一 `attempt_id`；`(stage_run_id, attempt_number)` 唯一。
- 状态事件由服务端在业务事务内产生；Agent 只能追加受限的 `agent_note`，不能伪造系统事件或确认记录。
- 部署、迁移、删除等外部副作用必须由 Operation Executor 执行：先准备意图并请求确认，执行时原子消费确认并转 executing，随后落 succeeded/unknown。结果未知时禁止自动重试，必须先对账。

## 9. Web 控制台设计

### 9.1 页面

1. **总览**：服务、SQLite、Adapter 状态和最近 Run。
2. **流程模板列表/编辑器**：模板版本、阶段、依赖、并行、角色、条件和安全门。
3. **角色目录/编辑器**：角色版本、输入输出、工具范围、禁止项和完成条件。
4. **Run 列表/详情**：来源客户端、模板快照、阶段、事件、日志、产物、文件变化和等待事项。
5. **项目记忆**：按项目查看决策、规则、经验和来源 Run。
6. **系统诊断**：本机服务、数据库路径、备份、Adapter 连接和版本兼容性。

### 9.2 Web 可执行操作

- 创建、复制、编辑和发布流程模板版本。
- 创建、编辑、启用和停用角色版本。
- 查看和筛选 Run、事件、日志、产物与记忆。
- 导出只读报告。

### 9.3 Web 明确没有的能力

- 没有创建或启动 Run 的路由。
- 没有暂停、恢复、取消、重试或跳过阶段的路由。
- 没有批准或拒绝确认的路由。
- 没有直接执行代码、命令、测试或部署的路由。
- 没有修改 `RunSnapshot` 或运行中 `StageRun` 配置的路由。

这不是“页面隐藏按钮”，而是服务端不给 Web 身份暴露对应能力。

Web 虽能改变未来 Run 的配置，但不能降低平台安全基线：mandatory gate 不可删除或绕过；角色能力只能从平台 allowlist 中取子集；危险能力、确认策略和安全策略版本由服务端固定。发布草稿前，服务端必须完成 DAG、Schema、角色引用和安全策略校验。

### 9.4 页面操作结果

| 页面 | 操作 | 结果 | 对运行中 Run 的影响 |
|---|---|---|---|
| 模板编辑器 | 调整阶段、依赖、并行并发布 | 生成不可变模板新版本 | 无 |
| 模板编辑器 | 配置人工确认点 | 新 Run 到此时由 Agent 会话询问 | 无 |
| 角色编辑器 | 修改职责、工具、输入输出 | 生成不可变角色新版本 | 无 |
| Run 列表 | 筛选并打开 Run | 读取只读详情 | 无 |
| Run 详情 | 查看日志或产物 | 读取已记录证据 | 无 |
| Run 详情 | 查看测试失败原因 | 读取失败 Attempt 与证据；提示回原客户端重试 | 无 |
| Run 详情 | 查看等待事项 | 显示应返回哪个 Agent 会话 | 无 |
| Codex/Claude 会话 | 启动流程 | 创建快照与 Run，开始执行 | 创建新 Run |

## 10. 服务接口与能力边界

### 10.1 Principal

| Principal | 来源 | 允许能力 |
|---|---|---|
| `web_admin` | loopback Web listener + HttpOnly Cookie + CSRF | 编辑/发布模板和角色；读取 Run |
| `agent_adapter` | 本机 stdio Adapter + Unix socket 安装凭证 | 创建、领取和推进自己拥有的 Run |
| `root_session` | Adapter 派生的会话 principal | 持租约提交 StageAttempt、产物和 Agent 命令 |
| `subagent` | 根会话内部派生 | 不连接 Control Server，只向根会话返回结果 |
| `system` | Control Server 内部 | 状态派生、事件、超时、迁移和安全校验 |

身份字段由认证通道派生，调用者不能在请求体中自报 `source_type`、客户端或用户身份。

### 10.2 Agent 读工具

| 工具 | 必需参数 | 说明 |
|---|---|---|
| `list_workflow_templates` | task type、project fingerprint | 列出已发布且通过安全校验的模板 |
| `get_workflow_version` | workflow version id | 返回不可变模板内容摘要 |
| `get_run_context` | run id、已认证 installation | 返回快照、frontier、产物引用和恢复要求 |
| `get_stage_context` | run id、stage run id、lease | 返回规范化角色内容和阶段输入 |

### 10.3 启动与领取工具

| 工具 | 前置条件 | 幂等/身份规则 |
|---|---|---|
| `create_run` | 已认证 Adapter；模板已发布；项目路径获准 | 不要求 run id/lease；要求 request id；返回 run id 与恢复凭证 |
| `claim_run` | `created`/`paused`/`interrupted`/可重试 `failed` | 要求 installation identity、恢复凭证和 expected status/lease epoch 的 compare-and-swap；retry 模式原子创建 Attempt |
| `heartbeat_run` | 当前有效 lease | 只延长当前 epoch，不改变业务状态 |

### 10.4 持租约写工具

| 工具 | 合法状态 | 服务端职责 |
|---|---|---|
| `begin_stage` | StageRun=`ready` | 新增 StageAttempt，校验 frontier 和并发策略 |
| `complete_stage` | Attempt=`running` | 原子 ingest/freeze 产物，校验退出 Schema，派生事件和后继阶段 |
| `fail_stage` | Attempt=`running` | 冻结失败证据，应用 failure policy |
| `retry_stage` | Run 仍 running 且 StageRun=`failed/interrupted` | 用于并行 Run 内仍持租约的局部重试；Run 已 failed 时改用 `claim_run(mode=retry)` |
| `skip_stage` | StageRun=`queued/ready` | 仅 optional 且安全策略允许 |
| `request_confirmation` | 快照配置了确认点或动作被安全基线拦截 | 创建一次性 ConfirmationRequest，不接受“用户已同意”布尔值 |
| `record_artifact` | 当前 Attempt 有效 | 把内容复制进 CAS，返回不可变 object id |
| `record_workspace_checkpoint` | 当前 Attempt 有效 | 保存 before/progress/after 指纹与 Patch/Manifest 对象 |
| `record_memory` | memory_docs 阶段或显式允许 | 去重、脱敏并保存来源 |
| `append_agent_note` | Run 非终态 | 只记受限备注；来源由通道派生 |
| `prepare_side_effect` | 当前 Attempt 有效 | 规范化动作、计算哈希、记录 intent，并创建/绑定 ConfirmationRequest |
| `execute_side_effect` | intent 已确认且未消费 | Operation Executor 原子消费确认、执行精确动作并记录 succeeded/unknown |
| `reconcile_side_effect` | 动作状态 unknown | 由受信执行器查询目标系统，保存对账证据和决定 |
| `pause_run` | Run=`running/waiting_for_user` | 释放租约并暂停 |
| `cancel_run` | Run 非终态 | 原子取消未完成阶段并释放租约 |
| `finalize_run` | Run=`running` | 客户端只请求重新计算；服务端决定能否 completed |

Agent 可见参数只含 `run_id + request_id`；`lease_epoch + lease_token` 由已认证 Adapter 根据可信根会话绑定自动附加，子 Agent 不可见。服务端幂等表负责所有命令去重，不把幂等性寄托在某一业务表字段上。

### 10.5 确认决定

`submit_confirmation` 不是普通模型可见工具，只能由可信 Adapter 的用户交互通道调用。决定必须绑定 `confirmation_request_id + nonce + exact_action_hash + expires_at`，且一次性消费。若某 Host 无法提供可验证的用户交互，首版对该 Host 禁止对应危险操作，而不是退化为让模型自由填写“已批准”。

### 10.6 Web HTTP 接口

- `/api/config/workflow-drafts/*`：流程草稿编辑。
- `/api/config/workflows/*/publish`：服务端校验并发布不可变版本。
- `/api/config/role-drafts/*`：角色草稿编辑。
- `/api/config/roles/*/publish`：服务端校验并发布不可变版本。
- `/api/read/runs/*`：Run 只读查询。
- `/api/read/events/*`：事件只读查询。
- `/api/read/artifacts/*`：产物只读查询或安全下载。
- `/api/read/memories/*`：记忆只读查询。
- `/api/read/system/*`：诊断只读查询。
- `/api/stream/events`：SSE 只读事件流。

Web listener 不注册任何 Run 启动、控制、确认或副作用路由；未知路由和未知能力默认拒绝。

## 11. SQLite 逻辑数据模型

时间统一保存 UTC。业务主键使用 UUID；`schema_migrations.version` 是唯一的整数主键例外。所有状态、类型和决定字段使用 `CHECK` 枚举；所有 JSON 使用 `{schema_id, schema_version, data}` 信封。

### 11.1 不可变内容

#### `content_objects`

- `id` UUID PK
- `sha256` UNIQUE NOT NULL
- `media_type`、`size_bytes`、`storage_key`、`created_at`

正文写入 `~/.project-orchestrator/objects/<sha256>`，采用临时文件 + fsync + 原子 rename；对象只读且不原地修改。Skill、规则、快照附件、证据和审计产物都引用该表。

### 11.2 流程配置

#### `workflow_templates`

- `id` PK、`slug` UNIQUE、`name`、`task_type`
- `status CHECK(active, disabled, archived)`
- `current_version_id`、`created_at`、`updated_at`

#### `workflow_drafts`

- `workflow_template_id` PK/FK
- `revision`、`draft_envelope`、`updated_at`

保存时要求预期 `revision`；发布成功后清空或基于已发布版本创建下一份草稿。

#### `workflow_versions`

- `id` PK、`workflow_template_id` FK
- `version_number`、`description`
- `safety_baseline_version`、`content_object_id` FK
- `content_hash`、`published_at`
- UNIQUE(`workflow_template_id`, `version_number`)

#### `workflow_stages`

- `id` PK、`workflow_version_id` FK
- `stage_key`、`name`、`role_version_id` FK
- `is_optional`、`is_mandatory_gate`
- `entry_schema_envelope`、`exit_schema_envelope`
- `failure_policy CHECK(pause, fail, retry_then_fail, trigger_iteration)`
- `max_attempts`、`iteration_group_key`
- `requires_confirmation`
- UNIQUE(`workflow_version_id`, `stage_key`)

#### `workflow_edges`

- `id` PK、`workflow_version_id` FK
- `from_stage_key`、`to_stage_key`
- `edge_type CHECK(requires, on_success)`
- `condition_envelope`
- UNIQUE(`workflow_version_id`, `from_stage_key`, `to_stage_key`, `edge_type`)

阶段键通过复合外键引用同一 `workflow_version_id`。发布事务检查 success graph 无环、可达性、mandatory gate、iteration 上限和安全基线。

#### `workflow_iteration_groups`

- `id` PK、`workflow_version_id` FK、`group_key`
- `entry_stage_key`、`gate_stage_keys_envelope`
- `aggregation_policy CHECK(collect_all)`、`max_iterations`
- UNIQUE(`workflow_version_id`, `group_key`)

返工唯一来源是 iteration group；`workflow_edges` 不表达失败回边。

### 11.3 角色配置

#### `roles`

- `id` PK、`slug` UNIQUE、`name`
- `status CHECK(active, disabled, archived)`
- `current_version_id`、`created_at`、`updated_at`

#### `role_drafts`

- `role_id` PK/FK
- `revision`、`draft_envelope`、`updated_at`

#### `role_versions`

- `id` PK、`role_id` FK、`version_number`
- `content_object_id` FK、`skill_hash`
- `input_schema_envelope`、`output_schema_envelope`
- `requested_capabilities`、`effective_capabilities`
- `forbidden_capabilities`、`completion_contract_envelope`
- `published_at`
- `status CHECK(published, revoked)`
- UNIQUE(`role_id`, `version_number`)

`effective_capabilities` 由服务端计算，只能是平台 allowlist 的子集。`current_version_id` 必须通过触发器验证版本属于同一模板/角色。

`disabled` 角色不可用于新模板发布或 create_run，但历史 Run 仍使用快照；`archived` 仅保留历史。安全撤销使用 `role_versions.status=revoked`，它会阻止新 Run 和恢复，不能被快照绕过。

### 11.4 客户端与项目

#### `client_installations`

- `id` PK、`client_type CHECK(codex, claude)`
- `adapter_version`、`capability_object_id` FK
- `credential_hash`、`status CHECK(active, disabled, revoked)`、`last_seen_at`
- UNIQUE(`client_type`, `id`)

#### `projects`

- `id` PK、`canonical_path` UNIQUE、`display_name`
- `repository_fingerprint`、`created_at`、`last_seen_at`

### 11.5 Run、阶段与尝试

#### `runs`

- `id` PK、`project_id` FK、`workflow_version_id` FK
- `objective`、`input_envelope`
- `origin_client_type`、`client_installation_id` FK、`origin_session_id`
- `lease_holder_session_id`
- `status CHECK(created, running, waiting_for_user, paused, interrupted, failed, cancelled, completed)`
- `lease_epoch`、`lease_token_hash`、`lease_expires_at`
- `recovery_credential_hash`
- `next_event_sequence`
- `started_at`、`updated_at`、`completed_at`
- `failure_code`、`failure_summary`、`is_retryable`

Run 的 active stage 集合由 `stage_runs` 推导，不保存单值 current stage。

#### `run_snapshots`

- `run_id` PK/FK
- `workflow_object_id`、`role_bundle_object_id`、`rule_bundle_object_id` FK
- `safety_baseline_object_id`、`adapter_capability_object_id` FK
- `repository_head`
- `staged_patch_object_id`、`unstaged_patch_object_id` FK
- `untracked_manifest_object_id`、`submodule_manifest_object_id` FK
- `working_tree_fingerprint`
- `created_at`

该指纹只作为 Run 开工基线；后续恢复改与最后一个可信 `workspace_checkpoints.resulting_fingerprint` 比较。

#### `workspace_checkpoints`

- `id` PK、`run_id`/`stage_attempt_id` FK
- `checkpoint_kind CHECK(run_start, before_attempt, progress, after_attempt)`
- `baseline_fingerprint`、`resulting_fingerprint`
- `staged_patch_object_id`、`unstaged_patch_object_id` FK
- `untracked_manifest_object_id`、`submodule_manifest_object_id` FK
- `created_at`

RunSnapshot 只是开工基线；恢复以最后一个可信 checkpoint 为基准。`after_attempt` 与成功 Attempt 在同一事务中关联，`progress` 只能由持租约根 Adapter 提交。

#### `stage_runs`

- `id` PK、`run_id` FK、`stage_key`
- `iteration_group_key` NULL、`iteration_number` NOT NULL DEFAULT 0
- `role_version_id` FK
- `status CHECK(queued, ready, running, waiting_for_user, succeeded, failed, skipped, cancelled, interrupted)`
- `latest_attempt_id`、`max_attempts`
- `created_at`、`updated_at`、`completed_at`
- UNIQUE(`run_id`, `stage_key`, `iteration_number`)

#### `run_iterations`

- `id` PK、`run_id` FK、`group_key`、`iteration_number`
- `status CHECK(running, succeeded, failed)`
- `findings_manifest_object_id` FK、`created_at`、`completed_at`
- UNIQUE(`run_id`, `group_key`, `iteration_number`)

#### `stage_attempts`

- `id` PK (`attempt_id`)、`stage_run_id` FK
- `attempt_number`、`status CHECK(running, succeeded, failed, interrupted)`
- `input_envelope`、`output_envelope`
- `artifact_manifest_object_id`、`evidence_manifest_object_id` FK
- `changed_files_object_id` FK
- `started_at`、`completed_at`
- `failure_code`、`failure_summary`
- UNIQUE(`stage_run_id`, `attempt_number`)

阶段成功时，Attempt 输出、Artifact/Evidence manifest 和哈希在同一事务中冻结；成功后禁止追加或替换该 Attempt 的证据。

### 11.6 确认、外部副作用与证据

#### `confirmation_requests`

- `id` PK、`run_id`/`stage_run_id` FK
- `confirmation_type`、`request_summary`
- `action_hash`、`nonce_hash`
- `safety_baseline_object_id` FK
- `status CHECK(pending, approved, rejected, expired, consumed)`
- `requested_at`、`expires_at`
- `decision_client_installation_id`、`decision_session_id`
- `decided_at`、`consumed_at`

确认必须在动作执行时原子消费；动作哈希不一致、过期或已消费均拒绝。

#### `side_effect_operations`

- `id` PK、`run_id`/`stage_attempt_id` FK
- `action_type`、`target_fingerprint`、`request_hash`
- `confirmation_request_id` FK、`lease_epoch`
- `status CHECK(intent_recorded, executing, succeeded, unknown, reconciled, abandoned)`
- `external_reference`
- `created_at`、`started_at`、`completed_at`

#### `artifacts`

- `id` PK、`run_id`/`stage_attempt_id` FK
- `artifact_type CHECK(document, log, test_evidence, file_manifest, ui_prototype, deployment_record, rollback_record, other)`
- `content_object_id` FK、`source_path`、`summary`
- `producer_role_version_id` FK、`metadata_envelope`、`created_at`

审计产物必须复制进 CAS；`source_path` 只是来源信息。HTML/SVG 等主动内容只能下载，或在独立无凭证 origin/sandbox 中展示，不能与配置 Web 同源直接执行。

#### `memories`

- `id` PK、`project_id`/`source_run_id` FK
- `memory_type`、`scope`、`title`、`summary`
- `content_object_id` FK、`retention_policy`、`created_at`

### 11.7 审计与幂等

#### `events`

- `id` PK、`run_id`/`stage_run_id` FK
- `sequence_number`、`event_type`、`source_principal_id`
- `payload_envelope`、`created_at`
- UNIQUE(`run_id`, `sequence_number`)

`sequence_number` 使用 `runs.next_event_sequence` 在同一事务中原子分配，禁止 `MAX()+1`。系统状态事件只能由服务端生成；Agent 备注使用独立 event type。

#### `idempotency_requests`

- `id` PK、`principal_id`、`operation`、`request_id`
- `request_hash`、`response_envelope`、`status CHECK(in_progress, completed, failed)`、`created_at`
- UNIQUE(`principal_id`, `operation`, `request_id`)

#### `schema_migrations`

- `version` INTEGER PK、`name`、`checksum`、`applied_at`

### 11.8 删除与索引规则

- 已发布版本、Run、Attempt、确认、外部副作用和事件使用 `ON DELETE RESTRICT`，不物理级联删除。
- 用户删除配置采用归档；清理历史数据必须走独立维护流程并先备份。
- 为 Run 状态、更新时间、项目、StageRun 状态、事件序号、Artifact 类型和 CAS 哈希建立索引。
- draft、发布、create_run、complete_stage、确认消费和事件写入均有明确事务边界。

## 12. 本机运行与安装

### 12.1 运行目录

```text
~/.project-orchestrator/
  ├─ orchestrator.db
  ├─ backups/
  ├─ logs/
  ├─ objects/
  └─ runtime/
      ├─ service.pid
      ├─ web-token
      ├─ adapter-credential
      ├─ control.sock
      └─ endpoint.json        # only port/socket/version; no secret
```

### 12.2 服务启动

- Linux：安装 `systemd --user` 服务，登录后启动；失败时 `Restart=on-failure`、`RestartSec=2s`，60 秒内最多重启 5 次。
- macOS：安装 `LaunchAgent`，登录后启动并保持服务存活。
- Web 固定监听 `127.0.0.1` 的安装期分配端口；`endpoint.json` 只记录端口、socket 路径和协议版本，令牌单独保存。
- Agent Host 连接 stdio MCP Adapter，Adapter 再通过 `control.sock` 连接 Control Server；Web 使用 loopback HTTP。
- 根目录、runtime、数据库、令牌、备份和对象目录默认仅当前用户可访问：目录 `0700`，秘密与数据文件 `0600`。
- 常驻服务只管理状态、配置、Web 和连接，不在 Agent 关闭后自行调用模型或修改代码。

### 12.3 备份与迁移

- SQLite 使用 WAL 模式和外键约束。
- 每次迁移前创建一致性备份。
- 首版默认保留最近 10 份本机备份；允许配置 3–50 份，少于 3 或多于 50 拒绝。
- 迁移脚本必须带版本、校验值和向前升级路径。
- 首版不承诺自动降级数据库；回滚应用前必须验证数据库兼容性或恢复迁移前备份。

## 13. 安全设计

### 13.1 不可降级安全基线

安全基线独立于 Web 模板和角色草稿，由安装版本提供并保存为不可变对象。Web 只能收紧，不能放宽：

- mandatory gate 不可删除、跳过或用条件边绕过；
- 角色 `effective_capabilities` 只能是系统 allowlist 与角色请求能力的交集；
- 通过本系统受控执行器执行、或要计入合法 Run 结果的删除、生产部署、不可逆迁移、秘密访问始终要求动作级确认；
- 安全策略对象由服务端选择，Web 不能切换到旧策略；
- 发布模板/角色前必须做服务端 policy validation，失败则不能发布。

### 13.2 身份与传输

- Control Server 的 Web listener 仅绑定回环地址，不监听 `0.0.0.0`，并校验 Host 与 Origin，防止 DNS rebinding。
- Web 使用高熵本机令牌、HttpOnly/SameSite Cookie 和 CSRF token。
- Agent Adapter 通过权限为 `0600` 的 Unix socket 与独立安装凭证认证；Web 浏览器无法访问该 socket。
- principal 和 capability 从认证通道派生，不能由请求体自报。
- 令牌只存哈希或 `0600` 秘密文件，支持轮换；`endpoint.json` 不含秘密。
- 同一用户账户下的恶意本机进程不属于首版可完全防御的威胁；本设计通过文件权限、能力分离和审计降低风险，但不声称提供操作系统级隔离。

### 13.3 工具约束

- 角色优先运行在 Host 提供的受限子 Agent/角色上下文中，只暴露 Adapter 计算后的有效工具集合。
- 危险副作用必须经过独立的 Operation Executor helper 进程；Control Server 只把已确认的精确动作通过本机 IPC 交给它。生产凭据只注入该 helper，不进入 Control Server、根会话或普通 Shell 环境。
- 若安装环境已有可被根 Shell 直接使用的生产凭据，或 Host 不能证明工具裁剪/可信用户确认，capability check 必须禁用自动危险阶段，改为生成手工操作说明。
- 用户在编排流程之外直接使用 Host Shell 不受本系统控制；本系统只保证未经确认的动作不能通过受控执行器成为合法 Run 结果，不声称能够约束拥有独立生产凭据的本机用户。

### 13.4 确认与副作用

- ConfirmationRequest 绑定一次性 nonce、精确动作哈希、项目、Run、阶段、安全策略和有效期。
- 确认决定只能来自可信 Adapter 的用户交互通道，且一次性消费。
- 外部副作用遵循 `intent_recorded → executing → succeeded/unknown → reconciled`；`execute_side_effect` 在本地事务中原子消费确认并标记 executing，外部调用无法与 SQLite 原子提交，因此进程崩溃时统一落 unknown 后对账。
- `unknown` 不自动重试；先读取外部状态对账，再由 Agent 会话决定。
- `finalize_run` 只触发服务端重新计算，客户端不能直接设置 `completed`。

### 13.5 内容与数据安全

- 外部网页、仓库文档和历史记忆都是不可信数据，不能覆盖系统、用户或工作区规则。
- 敏感值不写入事件、日志、产物摘要或记忆；持久化前执行脱敏。
- Artifact ingest 使用打开文件后的真实路径与文件描述符校验，拒绝目录穿越、越界 symlink 和不允许的硬链接来源。
- 审计产物复制到只读 CAS，不在展示时重新读取可变 `source_path`。
- HTML/SVG 等主动内容只能安全下载，或在独立无凭证 origin/sandbox 展示，避免 stored XSS 访问配置 Cookie。
- Web 使用严格 CSP，不加载第三方脚本、字体或分析服务。
- 事件追加写入、单调编号，系统事件只能由 Control Server 在业务事务中生成。


## 14. 错误处理与恢复

| 故障 | 行为 |
|---|---|
| Control Server 崩溃/重启 | SQLite 事务/WAL 恢复；`server_epoch` 增加，旧租约全部失效；原 `running/waiting_for_user` Run 转 `interrupted` 并要求重新领取 |
| Agent 会话关闭 | 心跳超时后 Run/当前 Attempt 进入 `interrupted`；Web 继续只读展示 |
| 原客户端恢复 | 校验 installation、恢复凭证、Adapter capability 和 working-tree fingerprint 后签发新 lease epoch |
| 工作区不一致 | 返回稳定 mismatch code；拒绝静默续跑，用户只能恢复原工作区或 fork 新 Run |
| Web 断开 | SSE 用最后事件序号重连补齐；不影响 Run |
| 模板/角色并发编辑 | draft revision/ETag 不匹配时拒绝覆盖 |
| 角色被停用 | 已有 Run 使用快照继续；新模板发布时引用校验失败 |
| 产物丢失或篡改 | CAS 哈希校验失败，阶段不能通过退出契约 |
| 外部副作用结果未知 | 转 `unknown`，禁止自动重试；对账后记录 `reconciled/abandoned` |
| Adapter 版本或能力不兼容 | create/claim 前 capability check 失败并返回明确缺失能力 |
| 确认过期或动作变化 | 确认失效，必须针对新动作重新请求，禁止复用 |

恢复 mismatch code 首版固定为：`PROJECT_PATH_CHANGED`、`REPOSITORY_HEAD_CHANGED`、`WORKTREE_CHANGED`、`RULE_BUNDLE_CHANGED`、`ADAPTER_INCOMPATIBLE`、`SAFETY_BASELINE_INCOMPATIBLE`、`ARTIFACT_MISSING`。


## 15. 技术选择

- 语言：TypeScript。
- 仓库：单仓多包结构。
- Web：React，构建为本机静态资源。
- 服务：Node.js 本机进程。
- 数据库：SQLite。
- Agent 协议：MCP + 公共 Agent Skills。
- Web API：loopback HTTP；实时观察使用 SSE。
- 契约：JSON Schema，所有跨组件输入输出版本化。
- 测试：单元测试、状态机性质测试、SQLite 集成测试、Adapter 契约测试、Web E2E、Linux/macOS 安装冒烟。

开源库只承担基础能力；业务状态机、权限边界、角色契约和编排逻辑由本项目实现。

## 16. 测试策略

### 16.1 单元与性质测试

- Run/StageRun/StageAttempt 转换矩阵中的全部合法与非法事件。
- DAG 验证：无环、依赖存在、必需安全门不可删除。
- 模板/角色版本不可变。
- RunSnapshot 不受后续编辑影响。
- 幂等表、lease epoch/fencing、心跳、服务重启和延迟旧请求。
- 角色输入输出 Schema 校验。
- 有限条件 DSL、有界返工 iteration、最大轮数和 mandatory gate 传播。
- draft 发布、不可变版本和平台安全基线不可降级。

### 16.2 集成测试

- SQLite 事务、WAL、迁移、备份和故障恢复。
- MCP Adapter 与 Control Server 写接口。
- Web 配置写接口和 Run 只读接口的能力隔离。
- SSE 断线重连和事件补齐。
- CAS 原子 ingest、Artifact manifest 冻结、路径/symlink、摘要和哈希校验。
- 一次性 ConfirmationRequest、动作哈希、过期、防重放和 side-effect 对账。

### 16.3 端到端测试

- Codex 从会话启动新项目模板并完成模拟 Run。
- Claude 从会话启动相同模板并产生等价快照结构。
- Web 编辑模板后，新 Run 使用新版本，旧 Run 不变。
- Web 全站不存在 Run 启动、控制和确认入口。
- Web principal 即使直接请求 Agent listener/能力也必须被拒绝。
- Agent 中断后 Web 保留状态，原客户端可恢复。
- Linux/macOS 登录后服务自动启动并可访问。

### 16.4 安全测试

- Web 身份调用 Agent 写接口必须拒绝。
- 非回环访问必须拒绝。
- CSRF、路径穿越、恶意 Artifact 元数据和日志注入测试。
- Prompt injection 内容不得改变规则优先级。
- 秘密脱敏与禁止持久化测试。

## 17. 验收标准

1. Linux 与 macOS 登录后，本机服务自动启动且只监听回环地址。
2. Web 能创建、编辑、发布模板和角色新版本。
3. Web 找不到并且无法调用任何 Run 启动、控制或确认接口。
4. Codex 与 Claude 都能使用同一公共模板创建结构一致的 RunSnapshot。
5. Run 创建后修改模板或角色，不影响该 Run。
6. Web 能持续看到阶段、事件、日志、产物、失败原因和等待事项。
7. Agent 会话关闭后不继续执行；状态保留，同一客户端安装实例的新会话可凭轮换恢复凭证恢复。
8. 开发角色不能绕过审查、测试和必需安全门宣布流程完成。
9. 通过受控执行器执行、或要计入合法 Run 结果的生产发布、删除数据等危险操作必须绑定一次性动作确认；Host 无可信确认能力时该受控危险动作被禁用。
10. SQLite 迁移、备份、事件追踪和故障恢复通过自动化验证。
11. Codex 与 Claude 安装包均通过真实客户端冒烟验证。
12. 所有跨组件数据通过版本化 Schema 校验。
13. 并行阶段由根会话单写提交；旧 lease epoch、重复命令和延迟请求不能重复推进状态或副作用。
14. Stage 重试新增 Attempt 且保留历史证据；返工达到上限后 Run 失败，不无限循环。
15. Web 发布的模板或角色无法删除 mandatory gate、扩大平台禁用能力或选择旧安全基线。
16. RunSnapshot 引用完整不可变 Workflow/Role/Rule/Safety/Capability 对象和 working-tree 指纹。

## 18. 实施阶段边界

设计通过后，实施计划按以下顺序拆解，但开发完成后统一执行全套验证：

1. 公共契约、Schema 与数据模型。
2. SQLite 存储、迁移和备份。
3. 工作流状态机、快照、租约和事件。
4. 10 个角色 Skill 与总控 Skill。
5. Codex Adapter 与 Claude Adapter。
6. Web 模板/角色编排和 Run 只读观察。
7. Linux/macOS 安装、自启动和诊断。
8. 集成、端到端、安全和安装验证。

## 19. 主要风险与缓解

| 风险 | 缓解 |
|---|---|
| 把 Skill 当确定性函数 | 由状态机、Schema 和退出契约判断，不接受角色口头“完成” |
| 角色和上下文膨胀 | 只传产物摘要与引用，按模板跳过无关角色 |
| Web 越权控制 Run | 从服务接口层隔离能力，不只隐藏按钮 |
| 运行中配置漂移 | RunSnapshot 冻结模板、角色、规则、Adapter 和仓库状态 |
| 两个会话重复执行 | 租约、心跳、幂等键和单写者约束 |
| 实现角色自证通过 | 审查、测试、安全作为独立阶段并保存原始证据 |
| 危险操作误执行 | Agent 会话确认、服务端安全策略、意图/结果双记录 |
| 记忆污染或泄密 | 分层、去重、脱敏、来源追踪与保留策略 |
| 客户端能力差异 | Adapter capability check 和公共契约测试 |
| 本机数据库损坏 | WAL、事务、迁移前备份、哈希与恢复演练 |

## 20. 设计结论

首版采用“本机编排核心 + SQLite + Web 编排/观察 + Codex/Claude 双 Adapter”。Agent 是唯一执行入口，Web 永远不替用户按下执行键。公共角色和流程语义保持厂商无关，客户端差异封装在 Adapter 中，为未来接入其他 Agent 留出稳定边界。
