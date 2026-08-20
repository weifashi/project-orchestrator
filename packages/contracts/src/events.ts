export const SERVER_EVENT_TYPES = [
  'run_created','run_claimed','run_heartbeat','run_paused','run_interrupted','run_failed','run_cancelled','run_completed',
  'stage_ready','stage_started','stage_succeeded','stage_failed','stage_retried','stage_skipped','stage_interrupted',
  'confirmation_requested','confirmation_approved','confirmation_rejected','confirmation_consumed',
  'artifact_recorded','checkpoint_recorded','memory_recorded','side_effect_prepared','side_effect_executing','side_effect_succeeded','side_effect_unknown','side_effect_reconciled',
] as const;
export const AGENT_EVENT_TYPES = ['agent_note'] as const;
export type ServerEventType = typeof SERVER_EVENT_TYPES[number];
export type AgentEventType = typeof AGENT_EVENT_TYPES[number];
export type EventType = ServerEventType | AgentEventType;
export function isAgentOwnedEvent(type: string): type is AgentEventType { return type === 'agent_note'; }
