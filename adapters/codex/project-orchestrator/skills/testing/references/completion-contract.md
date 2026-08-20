# Completion contract

A successful output is accepted only when:

- `test_matrix` is present and references durable artifact content.
- `commands_and_exit_codes` is present and references durable artifact content.
- `raw_evidence` is present and references durable artifact content.
- Risks and next-stage notes are explicit, even when empty.
- Artifact and evidence ids resolve to immutable objects.
- The role makes none of the forbidden claims in `SKILL.md`.
