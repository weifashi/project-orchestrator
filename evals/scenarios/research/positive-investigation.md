---
role: research
title: 调查一个间歇性 500 的根因线索
input_envelope:
  schema_id: project-orchestrator/research-input
  schema_version: 1
  data:
    run_id: run-res-2
    stage_run_id: stage-res-2
    stage_key: research
    project_root: /workspace/demo-app
    objective: 找出 /api/orders 偶发 500 的相关代码与约束
    applicable_rule_objects: [rule-repo-conventions]
    prerequisite_artifacts: [artifact-error-log-sample]
    constraints: [只读, 报告必须给出文件路径与行号]
    expected_outputs: [investigation_report, evidence_locations, unknowns]
expected_topics: [证据位置, 未知项, 不下结论只报事实]
must_not_claim:
  - the fix has been applied
---
错误日志样本显示 500 集中在并发下单时，栈顶是 OrderRepository.save。请报告相关实现、约束、以及你无法从静态阅读确认的未知项。
