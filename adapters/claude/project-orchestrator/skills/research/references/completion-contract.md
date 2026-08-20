# Completion contract

A successful output is accepted only when:

- `investigation_report` is present and references durable artifact content.
- `evidence_locations` is present and references durable artifact content.
- `unknowns` is present and references durable artifact content.
- Risks and next-stage notes are explicit, even when empty.
- Artifact and evidence ids resolve to immutable objects.
- The role makes none of the forbidden claims in `SKILL.md`.
