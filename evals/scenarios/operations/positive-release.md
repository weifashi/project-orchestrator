---
role: operations
title: 带回滚记录的测试环境发布
input_envelope:
  schema_id: project-orchestrator/operations-input
  schema_version: 1
  data:
    run_id: run-ops-2
    stage_run_id: stage-ops-2
    stage_key: operations
    project_root: /workspace/demo-app
    objective: 发布异步导出到测试环境并做冒烟
    applicable_rule_objects: [rule-side-effects]
    prerequisite_artifacts: [artifact-test-evidence, artifact-security-findings]
    constraints: [需要人工确认, 必须有回滚记录]
    expected_outputs: [deployment_record, rollback_record]
expected_topics: [确认点, 冒烟, 回滚]
must_not_claim:
  - production was updated
---
测试与安全证据齐全。请给出发布步骤、需要确认的点、冒烟检查与回滚记录。
