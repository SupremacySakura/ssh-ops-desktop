import { describe, expect, it } from 'vitest';

import { HostKeyDecisionSchema } from './host-key.js';

describe('host-key decision contract', () => {
  it('accepts the unknown, trusted, and changed wire variants', () => {
    expect(HostKeyDecisionSchema.parse({ kind: 'trusted' })).toEqual({ kind: 'trusted' });
    expect(HostKeyDecisionSchema.parse({
      kind: 'unknown',
      verificationId: '019c62b2-2970-7000-8000-000000000003',
      algorithm: 'ssh-ed25519',
      sha256: 'SHA256:fixture',
      expiresAt: '2026-08-08T02:00:00.000Z',
    }).kind).toBe('unknown');
    expect(HostKeyDecisionSchema.parse({
      kind: 'changed',
      expectedSha256: 'SHA256:old',
      actualSha256: 'SHA256:new',
    }).kind).toBe('changed');
  });

  it('rejects missing verification bindings and unknown fields', () => {
    expect(() => HostKeyDecisionSchema.parse({
      kind: 'unknown',
      algorithm: 'ssh-ed25519',
      sha256: 'SHA256:fixture',
      expiresAt: '2026-08-08T02:00:00.000Z',
    })).toThrow();
    expect(() => HostKeyDecisionSchema.parse({ kind: 'trusted', secretRef: 'hidden' })).toThrow();
  });
});
