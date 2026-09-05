---
role: requirements
title: 为退款流程写可验证的验收标准
input_envelope:
  schema_id: project-orchestrator/requirements-input
  schema_version: 1
  data:
    run_id: run-req-2
    stage_run_id: stage-req-2
    stage_key: requirements
    project_root: /workspace/demo-app
    objective: 会员在 7 天内可对已完成订单申请退款
    applicable_rule_objects: [rule-refund-window]
    prerequisite_artifacts: [artifact-product-brief]
    constraints: [退款金额不得超过实付, 已使用优惠券的订单需扣回优惠]
    expected_outputs: [acceptance_criteria, open_questions]
expected_topics: [边界条件, 可验证, 优惠券扣回]
must_not_claim:
  - implementation is complete
---
产品简报只写了"支持退款"。请产出能被测试角色直接转成用例的验收标准，并把简报没有覆盖的点列为待澄清问题。
