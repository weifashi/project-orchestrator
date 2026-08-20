import { expect, it, vi } from "vitest";
import { subscribeToRunEvents } from "../src/api/events";
import { fakeApi } from "./fixtures";
it("fills gaps and de-duplicates run sequence numbers before reconnecting", async () => {
  const received: number[] = [],
    sources: Array<{
      close: ReturnType<typeof vi.fn>;
      addEventListener: ReturnType<typeof vi.fn>;
      onmessage: ((e: MessageEvent) => void) | null;
      onerror: ((e: Event) => void) | null;
    }> = [];
  const api = fakeApi({
    events: {
      list: vi.fn(async () => [
        {
          id: "e1",
          run_id: "run-1",
          stage_run_id: null,
          sequence_number: 1,
          event_type: "run_created",
          payload_envelope: {},
          created_at: "",
        },
      ]),
    },
  });
  const stop = subscribeToRunEvents({
    api,
    runId: "run-1",
    onEvent: (event) => received.push(event.sequence_number),
    eventSource: () => {
      const source = {
        close: vi.fn(),
        addEventListener: vi.fn(),
        onmessage: null,
        onerror: null,
      };
      sources.push(source);
      return source;
    },
  });
  await vi.waitFor(() => expect(sources).toHaveLength(1));
  sources[0]!.onmessage?.({
    data: JSON.stringify({
      id: "e1",
      run_id: "run-1",
      stage_run_id: null,
      sequence_number: 1,
      event_type: "run_created",
      payload_envelope: {},
      created_at: "",
    }),
  } as MessageEvent);
  expect(received).toEqual([1]);
  stop();
  expect(sources[0]!.close).toHaveBeenCalled();
});
