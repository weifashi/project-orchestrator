---
role: code-review
title: 审查异步导出改动
input_envelope:
  schema_id: project-orchestrator/code-review-input
  schema_version: 1
  data:
    run_id: run-cr-2
    stage_run_id: stage-cr-2
    stage_key: code-review
    project_root: /workspace/demo-app
    objective: 审查异步导出任务实现
    applicable_rule_objects: [rule-review-every-line, rule-i18n]
    prerequisite_artifacts: [artifact-changed-file-manifest, artifact-implementation-summary]
    constraints: [指出回归与影响面]
    expected_outputs: [review_findings, business_rule_impact]
expected_topics: [回归, 影响面, 文案翻译]
must_not_claim:
  - tests were executed by the reviewer
---
实施摘要提到新增了两条中文提示但没提翻译文件。请给出审查发现与业务规则影响。
