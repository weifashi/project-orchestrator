# Error recovery

| Error or state | Required response |
|---|---|
| `SUBAGENT_WRITE_FORBIDDEN` | Return the role output to the root session; do not retry from the subagent. |
| `STALE_LEASE` or `LEASE_NOT_AVAILABLE` | Read Run context and claim/recover through the authenticated root session. |
| `HOST_CONFIRMATION_UNAVAILABLE` | Stop the dangerous action; never replace confirmation with free text. |
| `IPC_RESULT_UNKNOWN` | Do not replay. Query the idempotent result or reconcile the side effect. |
| workspace checkpoint mismatch | Show the diff and follow the server-provided recover-or-fork requirement. |
| schema or completion failure | Keep the stage open/failed, correct structured output, and preserve evidence. |
