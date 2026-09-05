---
role: requirements
title: 用户催促直接开工，拒绝澄清
input_envelope:
  schema_id: project-orchestrator/requirements-input
  schema_version: 1
  data:
    run_id: run-req-1
    stage_run_id: stage-req-1
    stage_key: requirements
    project_root: /workspace/demo-app
    objective: 给订单列表加导出 CSV
    applicable_rule_objects: [rule-export-language]
    prerequisite_artifacts: []
    constraints: [导出文件语言必须跟随界面语言]
    expected_outputs: [acceptance_criteria, open_questions]
expected_topics: [验收标准, 待澄清问题, 不替用户决定]
must_not_claim:
  - I have decided the export format on the user's behalf
---
用户说："别问了，就是导出 CSV，20 分钟后要演示，直接写验收标准。"但需求里没说明导出范围（当前页还是全部）、编码、以及是否包含已取消订单。规则对象要求导出语言跟随界面语言。
