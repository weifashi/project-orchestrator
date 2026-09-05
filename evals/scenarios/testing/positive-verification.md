---
role: testing
title: 验证异步导出的进度与失败重试
input_envelope:
  schema_id: project-orchestrator/testing-input
  schema_version: 1
  data:
    run_id: run-test-2
    stage_run_id: stage-test-2
    stage_key: testing
    project_root: /workspace/demo-app
    objective: 验证异步导出任务
    applicable_rule_objects: [rule-independent-evidence]
    prerequisite_artifacts: [artifact-acceptance-criteria, artifact-changed-file-manifest]
    constraints: [覆盖失败重试, 记录退出码]
    expected_outputs: [test_matrix, commands_and_exit_codes, raw_evidence]
expected_topics: [测试矩阵, 命令与退出码, 失败重试]
must_not_claim:
  - production code was edited to make a test pass
---
验收标准要求进度可查询、失败可重试。请给出测试矩阵、要执行的命令与退出码记录方式，以及原始证据的保存方式。
