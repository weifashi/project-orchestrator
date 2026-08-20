# Completion contract

A successful output is accepted only when:

- `security_assessment` is present and references durable artifact content.
- `threat_findings` is present and references durable artifact content.
- `residual_risks` is present and references durable artifact content.
- Risks and next-stage notes are explicit, even when empty.
- Artifact and evidence ids resolve to immutable objects.
- The role makes none of the forbidden claims in `SKILL.md`.
