import type { FastifyReply, FastifyRequest } from "fastify";
import type { ServerResponse } from "node:http";
import type { EventRepository } from "@project-orchestrator/sqlite-store";

export type EventStreamConnections = Set<ServerResponse>;

export function closeEventStreams(connections: EventStreamConnections): void {
  for (const response of [...connections]) response.end();
}

export function streamEvents(
  events: EventRepository,
  pollIntervalMs = 100,
  connections?: EventStreamConnections,
): (request: FastifyRequest, reply: FastifyReply) => Promise<unknown> {
  return async (request, reply) => {
    const query = request.query as { run_id?: string; after?: string };
    if (query.run_id === undefined || query.run_id.length === 0) {
      return reply.code(400).send({ error: "run_id required" });
    }
    const header = request.headers["last-event-id"];
    const afterHeader =
      typeof header === "string" && header.length > 0
        ? Number(header)
        : Number(query.after ?? 0);
    if (!Number.isSafeInteger(afterHeader) || afterHeader < 0) {
      return reply.code(400).send({ error: "invalid Last-Event-ID" });
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reply.raw.flushHeaders();
    connections?.add(reply.raw);
    let after = afterHeader;
    let closed = false;
    const flush = (): void => {
      if (closed) return;
      for (const event of events.list(query.run_id as string, after)) {
        const wireEvent = {
          id: event.id,
          run_id: event.runId,
          stage_run_id: event.stageRunId,
          sequence_number: event.sequenceNumber,
          event_type: event.eventType,
          payload_envelope: event.payload,
          created_at: event.createdAt,
        };
        reply.raw.write(
          `id: ${event.sequenceNumber}\nevent: ${event.eventType}\ndata: ${JSON.stringify(wireEvent)}\n\n`,
        );
        after = event.sequenceNumber;
      }
    };
    flush();
    const poll = setInterval(flush, pollIntervalMs);
    const heartbeat = setInterval(() => {
      if (!closed) reply.raw.write(": keep-alive\n\n");
    }, 15_000);
    const close = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(poll);
      clearInterval(heartbeat);
      connections?.delete(reply.raw);
    };
    request.raw.once("aborted", close);
    reply.raw.once("close", close);
    return undefined;
  };
}
