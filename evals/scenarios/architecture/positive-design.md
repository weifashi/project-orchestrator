---
role: architecture
title: 设计导出任务的异步化方案
input_envelope:
  schema_id: project-orchestrator/architecture-input
  schema_version: 1
  data:
    run_id: run-arch-2
    stage_run_id: stage-arch-2
    stage_key: architecture
    project_root: /workspace/demo-app
    objective: 大数据量导出改为异步任务并可查询进度
    applicable_rule_objects: [rule-repo-conventions]
    prerequisite_artifacts: [artifact-research-report, artifact-acceptance-criteria]
    constraints: [沿用现有任务表, 不引入新的消息中间件]
    expected_outputs: [design_document, adr, implementation_plan]
expected_topics: [数据模型, 接口, ADR, 分步实施]
must_not_claim:
  - tests pass
---
调查报告指出现有 jobs 表可复用，验收标准要求进度可查询且失败可重试。给出设计、ADR 与分步实施计划。
