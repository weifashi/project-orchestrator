# Completion contract

A successful output is accepted only when:

- `build_record` is present and references durable artifact content.
- `deployment_or_operation_record` is present and references durable artifact content.
- `smoke_and_rollback_record` is present and references durable artifact content.
- Risks and next-stage notes are explicit, even when empty.
- Artifact and evidence ids resolve to immutable objects.
- The role makes none of the forbidden claims in `SKILL.md`.
