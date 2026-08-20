import type { FastifyReply, FastifyRequest } from 'fastify';
import type { EventRepository } from '@project-orchestrator/sqlite-store';

export function streamEvents(events: EventRepository, pollIntervalMs = 100): (
  request: FastifyRequest,
  reply: FastifyReply,
) => Promise<unknown> {
  return async (request, reply) => {
    const query = request.query as { run_id?: string };
    if (query.run_id === undefined || query.run_id.length === 0) {
      return reply.code(400).send({ error: 'run_id required' });
    }
    const header = request.headers['last-event-id'];
    const afterHeader = typeof header === 'string' && header.length > 0 ? Number(header) : 0;
    if (!Number.isSafeInteger(afterHeader) || afterHeader < 0) {
      return reply.code(400).send({ error: 'invalid Last-Event-ID' });
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.flushHeaders();
    let after = afterHeader;
    let closed = false;
    const flush = (): void => {
      if (closed) return;
      for (const event of events.list(query.run_id as string, after)) {
        reply.raw.write(`id: ${event.sequenceNumber}\nevent: ${event.eventType}\ndata: ${JSON.stringify(event)}\n\n`);
        after = event.sequenceNumber;
      }
    };
    flush();
    const poll = setInterval(flush, pollIntervalMs);
    const heartbeat = setInterval(() => {
      if (!closed) reply.raw.write(': keep-alive\n\n');
    }, 15_000);
    const close = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(poll);
      clearInterval(heartbeat);
    };
    request.raw.once('aborted', close);
    reply.raw.once('close', close);
    return undefined;
  };
}
