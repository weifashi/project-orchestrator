# Model-visible tool reference

Exactly nineteen orchestration write tools are visible. `create_run` and `claim_run` are bootstrap writes. The remaining seventeen require a hidden lease attached by the authenticated Adapter. Model-visible JSON never contains credentials, lease tokens, lease epochs, recovery credentials, principals, confirmation nonces, or confirmation decisions.

- Run: `create_run`, `claim_run`, `heartbeat_run`, `pause_run`, `cancel_run`, `finalize_run`
- Stage: `begin_stage`, `complete_stage`, `fail_stage`, `retry_stage`, `skip_stage`
- Evidence: `record_artifact`, `record_workspace_checkpoint`, `record_memory`, `append_agent_note`
- Confirmation/effects: `request_confirmation`, `prepare_side_effect`, `execute_side_effect`, `reconcile_side_effect`

`request_confirmation` only creates a request. `submit_confirmation` is deliberately absent and is handled by the trusted Host UI channel.
