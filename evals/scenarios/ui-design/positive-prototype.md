---
role: ui-design
title: 为导出进度页出可评审原型
input_envelope:
  schema_id: project-orchestrator/ui-design-input
  schema_version: 1
  data:
    run_id: run-ui-2
    stage_run_id: stage-ui-2
    stage_key: ui-design
    project_root: /workspace/demo-app
    objective: 导出任务进度与下载页
    applicable_rule_objects: [rule-html-mockup]
    prerequisite_artifacts: [artifact-design-document]
    constraints: [中文文案, 移动端可用]
    expected_outputs: [ui_prototype, interaction_states]
expected_topics: [状态, 空态与失败态, 交互说明]
must_not_claim:
  - deployed to production
---
设计文档定义了排队中、执行中、成功、失败四个任务状态。请产出原型与交互状态说明，供产品评审拍板。
