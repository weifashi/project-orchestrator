# Completion contract

A successful output is accepted only when:

- `changed_file_manifest` is present and references durable artifact content.
- `implementation_summary` is present and references durable artifact content.
- `affected_business_rules` is present and references durable artifact content.
- Risks and next-stage notes are explicit, even when empty.
- Artifact and evidence ids resolve to immutable objects.
- The role makes none of the forbidden claims in `SKILL.md`.
