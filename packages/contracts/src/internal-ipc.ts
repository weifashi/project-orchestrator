import { Type, type Static } from '@sinclair/typebox';
import { AgentToolNames } from './tool-contracts.js';
export const InternalPrincipalSchema = Type.Object({
  installation_id: Type.String({ minLength: 1 }),
  root_session_id: Type.String({ minLength: 1 }),
  session_id: Type.String({ minLength: 1 }),
}, { additionalProperties: false });
export const InternalIpcRequestSchema = Type.Object({
  tool: Type.Union(AgentToolNames.map((value) => Type.Literal(value))),
  principal: InternalPrincipalSchema,
  lease_epoch: Type.Optional(Type.Integer({ minimum: 1 })),
  lease_token: Type.Optional(Type.String({ minLength: 1 })),
  payload: Type.Unknown(),
}, { additionalProperties: false });
export type InternalPrincipal = Static<typeof InternalPrincipalSchema>;
export type InternalIpcRequest = Static<typeof InternalIpcRequestSchema>;
