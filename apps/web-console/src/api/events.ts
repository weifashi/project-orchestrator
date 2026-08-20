import type { ApiClient } from "./client";
import type { RunEvent } from "./types";
const eventTypes = [
  "run_created",
  "run_claimed",
  "run_heartbeat",
  "run_paused",
  "run_interrupted",
  "run_failed",
  "run_cancelled",
  "run_completed",
  "stage_ready",
  "stage_started",
  "stage_succeeded",
  "stage_failed",
  "stage_retried",
  "stage_skipped",
  "stage_interrupted",
  "confirmation_requested",
  "confirmation_approved",
  "confirmation_rejected",
  "confirmation_consumed",
  "artifact_recorded",
  "checkpoint_recorded",
  "memory_recorded",
  "side_effect_prepared",
  "side_effect_executing",
  "side_effect_succeeded",
  "side_effect_unknown",
  "side_effect_reconciled",
  "agent_note",
] as const;
type EventSourceLike = Pick<
  EventSource,
  "close" | "onmessage" | "onerror" | "addEventListener"
>;
type Options = {
  api: ApiClient;
  runId: string;
  onEvent: (event: RunEvent) => void;
  eventSource?: (url: string) => EventSourceLike;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
};
export function subscribeToRunEvents(options: Options): () => void {
  const factory =
      options.eventSource ??
      ((url) =>
        typeof EventSource === "undefined" ? undefined : new EventSource(url)),
    timer = options.setTimer ?? setTimeout,
    clear = options.clearTimer ?? clearTimeout,
    seen = new Set<string>();
  let last = 0,
    attempt = 0,
    closed = false,
    source: EventSourceLike | undefined,
    reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  const apply = (event: RunEvent) => {
    const key = `${event.run_id}:${event.sequence_number}`;
    if (seen.has(key)) return;
    seen.add(key);
    last = Math.max(last, event.sequence_number);
    options.onEvent(event);
  };
  const connect = async () => {
    if (closed) return;
    try {
      for (const missed of await options.api.events.list(options.runId, last))
        apply(missed);
    } catch {
      if (!closed) {
        const delay = Math.min(10_000, 250 * 2 ** attempt++);
        reconnectTimer = timer(() => {
          void connect();
        }, delay);
      }
      return;
    }
    if (closed) return;
    source = factory(
      `/api/stream/events?run_id=${encodeURIComponent(options.runId)}&after=${last}`,
    );
    if (!source) return;
    const receive = (message: MessageEvent) => {
      attempt = 0;
      apply(JSON.parse(message.data) as RunEvent);
    };
    source.onmessage = receive;
    for (const type of eventTypes)
      source.addEventListener(type, receive as EventListener);
    source.onerror = () => {
      source?.close();
      if (closed) return;
      const delay = Math.min(10_000, 250 * 2 ** attempt++);
      reconnectTimer = timer(() => {
        void connect();
      }, delay);
    };
  };
  void connect();
  return () => {
    closed = true;
    source?.close();
    if (reconnectTimer !== undefined) clear(reconnectTimer);
  };
}
