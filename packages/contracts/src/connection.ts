import { z } from 'zod';

import { CoreErrorCodeSchema } from './errors.js';
import { IdSchema } from './ids.js';

const Sha256Schema = z.string().trim().regex(/^SHA256:[A-Za-z0-9+/]+$/u);
const SequenceSchema = z.int().positive();
const ByteArraySchema = z.array(z.int().min(0).max(255));

export const ConnectionHandleSchema = z.object({
  serverId: IdSchema,
  connectionId: IdSchema,
}).strict();

export const HostKeyPromptSchema = z.object({
  verificationId: IdSchema,
  algorithm: z.string().trim().min(1),
  sha256: Sha256Schema,
  expiresAt: z.string().trim().min(1),
}).strict();

export const HostKeyChangedPromptSchema = z.object({
  verificationId: IdSchema,
  expectedSha256: Sha256Schema,
  actualSha256: Sha256Schema,
  expiresAt: z.string().trim().min(1),
}).strict();

export const ConnectOutcomeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('ready'),
    connection: ConnectionHandleSchema,
  }).strict(),
  z.object({
    kind: z.literal('hostKeyRequired'),
    prompt: HostKeyPromptSchema,
  }).strict(),
  z.object({
    kind: z.literal('hostKeyChanged'),
    prompt: HostKeyChangedPromptSchema,
  }).strict(),
]);

export const TerminalSessionSchema = z.object({
  id: IdSchema,
  connection: ConnectionHandleSchema,
}).strict();

export const TerminalDataSchema = z.object({
  terminalSessionId: IdSchema,
  sequence: SequenceSchema,
  bytes: ByteArraySchema,
}).strict();

export const TerminalGapSchema = z.object({
  terminalSessionId: IdSchema,
  missed: z.int().positive(),
}).strict();

export const TerminalCloseReasonSchema = z.enum([
  'remoteExit',
  'disconnected',
  'closed',
  'connectionClosed',
]);

export const TerminalClosedSchema = z.object({
  terminalSessionId: IdSchema,
  reason: TerminalCloseReasonSchema,
  exitStatus: z.int().nonnegative().optional(),
}).strict();

export const ConnectionStateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('connecting') }).strict(),
  z.object({ kind: z.literal('ready') }).strict(),
  z.object({ kind: z.literal('closed') }).strict(),
  z.object({
    kind: z.literal('error'),
    code: CoreErrorCodeSchema,
    message: z.string().min(1),
    retryable: z.boolean(),
  }).strict(),
]);

const ConnectionStateEventBaseSchema = z.object({
  serverId: IdSchema,
  sequence: SequenceSchema,
});

export const ConnectionStateEventSchema = z.union([
  ConnectionStateEventBaseSchema.extend({
    connectionId: z.null(),
    state: z.object({ kind: z.literal('connecting') }).strict(),
  }).strict(),
  ConnectionStateEventBaseSchema.extend({
    connectionId: IdSchema,
    state: z.object({ kind: z.literal('ready') }).strict(),
  }).strict(),
  ConnectionStateEventBaseSchema.extend({
    connectionId: IdSchema,
    state: z.object({ kind: z.literal('closed') }).strict(),
  }).strict(),
  ConnectionStateEventBaseSchema.extend({
    connectionId: z.null(),
    state: z.object({
      kind: z.literal('error'),
      code: CoreErrorCodeSchema,
      message: z.string().min(1),
      retryable: z.boolean(),
    }).strict(),
  }).strict(),
]);

export type ConnectionHandle = z.infer<typeof ConnectionHandleSchema>;
export type HostKeyPrompt = z.infer<typeof HostKeyPromptSchema>;
export type HostKeyChangedPrompt = z.infer<typeof HostKeyChangedPromptSchema>;
export type ConnectOutcome = z.infer<typeof ConnectOutcomeSchema>;
export type TerminalSession = z.infer<typeof TerminalSessionSchema>;
export type TerminalDataEvent = z.infer<typeof TerminalDataSchema>;
export type TerminalGapEvent = z.infer<typeof TerminalGapSchema>;
export type TerminalCloseReason = z.infer<typeof TerminalCloseReasonSchema>;
export type TerminalClosedEvent = z.infer<typeof TerminalClosedSchema>;
export type ConnectionState = z.infer<typeof ConnectionStateSchema>;
export type ConnectionStateEvent = z.infer<typeof ConnectionStateEventSchema>;
