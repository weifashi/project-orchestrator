import Fastify, { type FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { ContentStore } from '@project-orchestrator/content-store';
import { ConfigService } from '@project-orchestrator/orchestrator-service';
import { EventRepository, SqliteConfigRepository } from '@project-orchestrator/sqlite-store';
import { createConfigHandlers, registerConfigRoutes, type ConfigHandlers } from './routes/config.js';
import { registerReadRoutes } from './routes/read.js';
import { closeEventStreams, streamEvents, type EventStreamConnections } from './sse.js';

type WebListenerInput = {
  db: Database.Database;
  content: ContentStore;
  webToken: string;
  csrfToken: string;
  allowedOrigin: string;
  handlers?: ConfigHandlers;
  ssePollIntervalMs?: number;
};

export type WebListener = FastifyInstance & { closeEventStreams: () => void };

export function buildWebListener(input: WebListenerInput): WebListener {
  const app = Fastify({ logger: false });
  const eventStreams: EventStreamConnections = new Set();
  app.decorate('closeEventStreams', () => closeEventStreams(eventStreams));
  const sessionCookie = Buffer.from(input.webToken, 'utf8').toString('base64url');
  app.addHook('onRequest', async (request, reply) => {
    const host = request.headers.host?.split(':')[0];
    if (host !== '127.0.0.1' && host !== 'localhost') return reply.code(403).send({ error: 'invalid host' });
    const writes = request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'OPTIONS';
    if ((writes && request.headers.origin !== input.allowedOrigin)
      || (request.headers.origin !== undefined && request.headers.origin !== input.allowedOrigin)) {
      return reply.code(403).send({ error: 'invalid origin' });
    }
    const cookie = Object.fromEntries((request.headers.cookie ?? '').split(';')
      .map((part) => part.trim().split('=', 2) as [string, string]));
    if (cookie['po_session'] !== sessionCookie) return reply.code(403).send({ error: 'unauthorized' });
    if (writes && request.headers['x-csrf-token'] !== input.csrfToken) {
      return reply.code(403).send({ error: 'csrf' });
    }
  });
  app.addHook('onSend', async (request, reply, payload) => {
    const authenticated = (request.headers.cookie ?? '').split(';')
      .some((part) => part.trim() === `po_session=${sessionCookie}`);
    if (authenticated && reply.statusCode < 400) {
      reply.header('Set-Cookie', `po_session=${sessionCookie}; HttpOnly; SameSite=Strict; Path=/`);
    }
    return payload;
  });
  const handlers = input.handlers ?? createConfigHandlers(new ConfigService(
    new SqliteConfigRepository(input.db), input.content,
  ));
  registerConfigRoutes(app, handlers);
  registerReadRoutes(app, input.db, input.content);
  app.get('/api/stream/events', streamEvents(new EventRepository(input.db), input.ssePollIntervalMs, eventStreams));
  return app as unknown as WebListener;
}
