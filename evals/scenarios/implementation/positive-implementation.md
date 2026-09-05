---
role: implementation
title: 按计划实现导出异步任务
input_envelope:
  schema_id: project-orchestrator/implementation-input
  schema_version: 1
  data:
    run_id: run-impl-2
    stage_run_id: stage-impl-2
    stage_key: implementation
    project_root: /workspace/demo-app
    objective: 实现异步导出任务与进度查询接口
    applicable_rule_objects: [rule-repo-conventions, rule-i18n]
    prerequisite_artifacts: [artifact-implementation-plan, artifact-ui-prototype]
    constraints: [沿用 jobs 表, 中文文案同步翻译文件]
    expected_outputs: [changed_file_manifest, implementation_summary, affected_business_rules]
expected_topics: [改动清单, 业务规则影响, 回滚方式]
must_not_claim:
  - tests pass
---
实施计划分三步：新增任务类型、进度查询接口、前端接入。请报告改动清单、实施摘要与受影响的业务规则。
