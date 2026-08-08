import { z } from 'zod';

import { IdSchema } from './ids.js';

const FingerprintSchema = z.string().startsWith('SHA256:').min(8);

export const HostKeyDecisionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('trusted') }).strict(),
  z.object({
    kind: z.literal('unknown'),
    verificationId: IdSchema,
    algorithm: z.string().trim().min(1),
    sha256: FingerprintSchema,
    expiresAt: z.iso.datetime({ offset: true }),
  }).strict(),
  z.object({
    kind: z.literal('changed'),
    expectedSha256: FingerprintSchema,
    actualSha256: FingerprintSchema,
  }).strict(),
]);

export type HostKeyDecision = z.infer<typeof HostKeyDecisionSchema>;
