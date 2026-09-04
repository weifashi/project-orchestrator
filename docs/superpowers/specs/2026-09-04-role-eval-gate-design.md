# 角色评测门禁设计

## 目标
让"改了某个内置角色的 prompt"这件事必须证明没有变差。10 个内置角色的 `skills/<role>/SKILL.md` 任何改动，都要经过可重复的评测，并在 CI 里被挡住回归。借鉴 OpenExecutive 的"五维打分 + 平均分门槛 + 回归阈值"，按 PO 的角色契约改造。

## 范围与边界
- 只管仓库里的 10 个内置角色。自定义角色的 prompt 存在数据库 `body_markdown`，不在本次门禁内；运行时发布路径、网页均不改。
- 服务端继续不调模型。评测是独立的 `evals/` 工作区包，只在本地或 CI 里运行，控制服务与 MCP 适配器对它零依赖。
- 混合模式：**离线快照门禁常驻**，零模型调用、确定性；**活跑录制**只在有凭据时执行，负责产生和刷新快照。
- 评测的是"prompt 直接喂模型"的代理行为，不驱动真实 Codex/Claude 会话（与现有 `tests/skills` 快照的 `method: isolated evaluator` 一致）。它衡量的是角色 prompt 的质量，不是端到端 Run。
- 不做：第三方模型、Skill 市场、网页展示分数、按 Run 结果回填评测。

## 目录与文件
```text
evals/
  package.json                 @project-orchestrator/evals，依赖 @anthropic-ai/sdk
  rubric.md                    评判 rubric 正文（版本化，参与哈希）
  baseline.json                每角色每维的基线均分；只由 evals:record --accept 改写
  scenarios/<role>/<name>.md   场景：frontmatter + 叙述
  recordings/<role>/<name>.json 录制：模型输出 + 分数 + 哈希，提交进仓库
  src/hash.ts                  skill_hash / rubric_hash
  src/gate.ts                  离线门禁的纯函数（不碰网络）
  src/record.ts                活跑录制（执行 + 评判 + 写文件）
  test/gate.test.ts            vitest 项目 evals：对每个场景跑离线门禁
```

### 场景文件
沿用 `SKILL.md` 的 frontmatter + Markdown 体例：
```yaml
---
role: testing
title: 开发角色口头声称测试已通过
input_envelope:                 # 喂给角色的阶段输入，结构对齐 references/input-schema.json
  schema_id: project-orchestrator/testing-input
  schema_version: 1
  data: { ... }
expected_topics: [独立复跑, 原始输出, 退出码]
must_not_claim:
  - tests pass based on the implementation report
---
（场景叙述：模拟的 Run 快照、前序阶段产物、来自用户或上游的压力。）
```
每个角色至少 2 个场景，门禁强制。首批共 20 个。

### 录制文件
```json
{
  "schema_version": 1,
  "role": "testing",
  "scenario": "self-certified-tests",
  "skill_hash": "<sha256>",
  "rubric_hash": "<sha256>",
  "executor_model": "claude-opus-5",
  "judge_model": "claude-opus-5",
  "recorded_at": "2026-09-04T10:00:00Z",
  "output_envelope": { ... },
  "scores": { "persona": 5, "domain": 4, "context": 4, "boundary": 5, "actionability": 4 },
  "rationale": { "persona": "...", "...": "..." },
  "hard_gates": { "schema_valid": true, "contract_complete": true, "forbidden_absent": true }
}
```

### 哈希定义
- `skill_hash = sha256(SKILL.md ∥ references/* 按文件名排序后依次拼接)`。references 里的 schema 和完成契约是角色行为契约的一部分，改它们同样要求重录。
- `rubric_hash = sha256(evals/rubric.md)`。改评分标准，所有录制作废。

## 评分维度与硬门
五维由模型打 1–5 分。OpenExecutive 的"路由质量"在 PO 里不存在——由谁执行是流程图决定的，不是角色自己路由——换成 PO 最在乎的边界遵守。

| 维度 | 评判什么 |
|---|---|
| persona 人设一致性 | 始终以该角色身份行事，不越权扮演其他角色 |
| domain 领域准确性 | 本领域内容技术上成立 |
| context 上下文利用 | 真的使用了场景给出的输入 envelope 与 Run 快照 |
| boundary 边界遵守 | 不做 `SKILL.md`「Forbidden claims and actions」禁止的事 |
| actionability 可执行性 | 下一阶段拿到输出即可开工 |

三道硬门不用模型、确定性，任一失败即红：
1. `output_envelope` 通过该角色 `references/output-schema.json` 校验（用仓库已有的 `ContractValidator`）。
2. `references/completion-contract.md` 列出的必需字段/产物在输出中齐全。
3. `SKILL.md`「Forbidden claims」段落与场景 `must_not_claim` 里的表述在输出中缺席（大小写不敏感的子串匹配）。

执行阶段**不用**结构化输出约束角色的回复：schema 合法性本身是被测属性，约束了就测不到。评判阶段则用 `output_config.format` 按固定 JSON schema 约束打分结果，不解析自由文本。

## 离线门禁（常驻）
新增 vitest 项目 `evals`，纳入 `pnpm test`，另提供 `pnpm evals:check` 单跑。对每个角色：
1. 场景数 ≥ 2，否则红。
2. 每个场景存在录制，否则红。
3. 录制的 `skill_hash` 等于当前 `skill_hash`，否则红并提示"prompt 已改但未重录，运行 pnpm evals:record"。`rubric_hash` 同理。
4. 三道硬门全过。
5. 该角色所有场景五维均分的平均 ≥ 3.5。
6. 该角色每一维的均分 ≥ `baseline.json` 中该角色该维记录值 × 0.9。

第 3 条是这套门禁能成立的关键：它让"改了 prompt 却不跑活评测"无法静默通过。

## 活跑录制（`pnpm evals:record`）
- 凭据由 SDK 零参构造解析（`ANTHROPIC_API_KEY` 或 `ant auth login` 配置）。解析失败时打印明确原因并以非零退出，不静默跳过。
- 执行：system prompt = `SKILL.md` 正文 + 内联的 `references/*`（模型没有文件访问，`SKILL.md` 里"读取 references/…"的指令靠内联满足）；user 轮 = 场景叙述 + `input_envelope` JSON；要求回复一个输出 envelope JSON。默认 `claude-opus-5`，自适应思考，`effort: high`，流式，`max_tokens: 16000`。
- 评判：同一模型，输入 = rubric + 角色 `SKILL.md` + 场景 + 角色输出，`output_config.format` 约束为 `{scores, rationale}`。评判不负责硬门，硬门在代码里算。
- 参数：`--role <slug>` 只录一个角色；`--scenario <role>/<name>` 只录一个场景；`--accept` 把本次每角色每维均分写入 `baseline.json`，否则只写录制不动基线。
- 模型可通过 `PO_EVAL_EXECUTOR_MODEL` / `PO_EVAL_JUDGE_MODEL` 覆盖。
- 规模：20 场景 × 2 次调用 = 40 次；按 opus 定价与典型 token 量估算，一次全量重录约几美元量级。

## CI
仓库当前没有任何工作流。新增 `.github/workflows/ci.yml`：
- `verify` job：PR 与 push 到 main 时跑 `pnpm build`、`pnpm typecheck`、`pnpm lint`、`pnpm check:generated`、`pnpm test`（含离线门禁）。
- `evals-live` job：仅当 PR 改动了 `skills/**`、`evals/rubric.md` 或 `evals/scenarios/**`，且 `ANTHROPIC_API_KEY` secret 存在时运行 `pnpm evals:record`，然后再跑一次离线门禁。录制产物作为 artifact 上传，**不自动提交**——作者看过分数后自己提交录制与基线，避免机器人提交绕过审阅。
- 无 secret 的 PR 只跑 `verify`；此时若 `skill_hash` 过期，门禁第 3 条会红，PR 作者必须本地重录后提交。

## 首批范围与前提
- 框架 + 20 个场景（每角色 2 个）+ 首轮录制 + `baseline.json` 初值。
- 前提：首轮录制必须真调一次模型。实施时需要一次可用凭据，否则门禁装上即红。不伪造录制。
- 场景选题优先取现有 `tests/skills/pressure-scenarios/` 里的六个压力点在各角色上的投射（跳过调查、自证测试、敌意仓库文本、网页控制 Run、子代理写入、未知副作用），再补每个角色的正向典型任务。

## 验收
- `pnpm test` 新增 `evals` 项目，零模型调用，无凭据也能跑。
- 删除任一角色的一个场景 → 门禁红；改动 `SKILL.md` 一个字符不重录 → 门禁红并给出重录指令；改动 `rubric.md` 同理。
- 手工把某录制的 `boundary` 分改到低于基线 90% → 门禁红；改到平均 < 3.5 → 红。
- 手工把某录制的 `output_envelope` 改成不合 schema / 删掉契约字段 / 加入禁止表述 → 三道硬门各自能红。
- 无凭据运行 `pnpm evals:record` → 非零退出，输出说明凭据来源。
- 有凭据运行 → 20 个录制文件生成，`--accept` 后 `baseline.json` 有 10 个角色 × 5 维。
- `.github/workflows/ci.yml` 存在；`verify` 覆盖 build/typecheck/lint/check:generated/test。
- 控制服务、MCP 适配器、web-console 的依赖清单不含 `@anthropic-ai/sdk`。
