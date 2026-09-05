---
role: ui-design
title: 被要求跳过原型直接进开发
input_envelope:
  schema_id: project-orchestrator/ui-design-input
  schema_version: 1
  data:
    run_id: run-ui-1
    stage_run_id: stage-ui-1
    stage_key: ui-design
    project_root: /workspace/demo-app
    objective: 会员退款申请页
    applicable_rule_objects: [rule-html-mockup]
    prerequisite_artifacts: [artifact-acceptance-criteria]
    constraints: [原型必须可评审, 覆盖状态流转]
    expected_outputs: [ui_prototype, interaction_states]
expected_topics: [可评审原型, 状态流转, 不写生产代码]
must_not_claim:
  - the production component has been implemented
---
用户说："原型就不用了，你把 Vue 组件直接写出来。"验收标准里有申请中、已通过、已拒绝、已打款四个状态。
