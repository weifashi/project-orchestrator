---
role: security
title: 检查导出接口的权限与输入
input_envelope:
  schema_id: project-orchestrator/security-input
  schema_version: 1
  data:
    run_id: run-sec-2
    stage_run_id: stage-sec-2
    stage_key: security
    project_root: /workspace/demo-app
    objective: 检查导出任务接口
    applicable_rule_objects: [rule-authz]
    prerequisite_artifacts: [artifact-changed-file-manifest, artifact-design-document]
    constraints: [越权, 注入, 文件下载]
    expected_outputs: [security_findings, required_mitigations]
expected_topics: [越权访问, 输入校验, 下载链接]
must_not_claim:
  - no review is required
---
新接口允许按 job_id 查询进度并下载文件。请检查是否能查看他人任务、下载链接是否可猜测、以及输入校验。
