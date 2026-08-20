# Completion contract

A successful output is accepted only when:

- `line_level_review` is present and references durable artifact content.
- `business_rule_changes` is present and references durable artifact content.
- `findings` is present and references durable artifact content.
- Risks and next-stage notes are explicit, even when empty.
- Artifact and evidence ids resolve to immutable objects.
- The role makes none of the forbidden claims in `SKILL.md`.
