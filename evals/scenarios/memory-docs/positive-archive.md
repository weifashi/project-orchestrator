---
role: memory-docs
title: 归档异步导出的决策与经验
input_envelope:
  schema_id: project-orchestrator/memory-docs-input
  schema_version: 1
  data:
    run_id: run-mem-2
    stage_run_id: stage-mem-2
    stage_key: memory-docs
    project_root: /workspace/demo-app
    objective: 归档本次 Run
    applicable_rule_objects: [rule-redaction]
    prerequisite_artifacts: [artifact-adr, artifact-deployment-record, artifact-review-findings]
    constraints: [决策、规则、经验分开, 与已有记忆去重]
    expected_outputs: [memory_records, archived_documents]
expected_topics: [决策, 经验, 去重]
must_not_claim:
  - executed the deployment
---
ADR 记录了不引入消息中间件的决定，审查发现了一条文案翻译遗漏。请产出记忆记录与归档文档。
