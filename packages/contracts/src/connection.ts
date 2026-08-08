import { z } from 'zod';

import { CoreErrorCodeSchema } from './errors.js';
import { IdSchema } from './ids.js';

const RequiredTextSchema = z.string().trim().min(1)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value));
const FingerprintSchema = z.string().startsWith('SHA256:').min(8);

export const ConnectionAuthSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('password') }).strict(),
  z.object({
    kind: z.literal('private_key'),
    privateKeyPath: RequiredTextSchema,
  }).strict(),
  z.object({ kind: z.literal('ssh_agent') }).strict(),
  z.object({
    kind: z.literal('certificate'),
    certificatePath: RequiredTextSchema,
    privateKeyPath: RequiredTextSchema,
    expectedPrincipal: RequiredTextSchema,
  }).strict(),
]);

export const ConnectionRequestSchema = z.object({
  serverId: IdSchema,
  auth: ConnectionAuthSchema,
}).strict();

export const ConnectionHandleSchema = z.object({
  serverId: IdSchema,
  connectionId: IdSchema,
}).strict();

const HostKeyPromptSchema = z.object({
  verificationId: IdSchema,
  algorithm: RequiredTextSchema,
  sha256: FingerprintSchema,
  expiresAt: z.iso.datetime({ offset: true }),
}).strict();

export const ConnectOutcomeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ready'), connection: ConnectionHandleSchema }).strict(),
  z.object({ kind: z.literal('host_key_required'), prompt: HostKeyPromptSchema }).strict(),
  z.object({
    kind: z.literal('host_key_changed'),
    expectedSha256: FingerprintSchema,
    actualSha256: FingerprintSchema,
  }).strict(),
]);

export const PtySizeSchema = z.object({
  columns: z.int().min(2).max(1_000),
  rows: z.int().min(2).max(1_000),
}).strict();

export const TerminalSessionSchema = z.object({
  id: IdSchema,
  connection: ConnectionHandleSchema,
}).strict();

export const TerminalDataEventSchema = z.object({
  terminalSessionId: IdSchema,
  sequence: z.int().positive(),
  bytes: z.array(z.int().min(0).max(255)).max(4 * 1024 * 1024),
}).strict();

export const ConnectionStateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('idle') }).strict(),
  z.object({ kind: z.literal('connecting') }).strict(),
  z.object({ kind: z.literal('host_verifying') }).strict(),
  z.object({ kind: z.literal('authenticating') }).strict(),
  z.object({ kind: z.literal('ready') }).strict(),
  z.object({ kind: z.literal('reconnecting'), attempt: z.int().min(1).max(255) }).strict(),
  z.object({ kind: z.literal('closed') }).strict(),
  z.object({ kind: z.literal('error'), code: CoreErrorCodeSchema }).strict(),
]);

export const ConnectionStateEventSchema = z.object({
  serverId: IdSchema,
  connectionId: IdSchema,
  sequence: z.int().positive(),
  state: ConnectionStateSchema,
}).strict();

export type ConnectionState = z.infer<typeof ConnectionStateSchema>;
export type ConnectionStateEvent = z.infer<typeof ConnectionStateEventSchema>;
export type ConnectionAuth = z.infer<typeof ConnectionAuthSchema>;
export type ConnectionRequest = z.infer<typeof ConnectionRequestSchema>;
export type ConnectionHandle = z.infer<typeof ConnectionHandleSchema>;
export type ConnectOutcome = z.infer<typeof ConnectOutcomeSchema>;
export type PtySize = z.infer<typeof PtySizeSchema>;
export type TerminalSession = z.infer<typeof TerminalSessionSchema>;
export type TerminalDataEvent = z.infer<typeof TerminalDataEventSchema>;
