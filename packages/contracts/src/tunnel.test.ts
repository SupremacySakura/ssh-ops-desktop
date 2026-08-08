import { describe, expect, it } from 'vitest';

import { RemoteSocketPathSchema, TunnelRuleSchema } from './tunnel.js';

describe('tunnel contracts', () => {
  it('requires explicit public bind confirmation', () => {
    expect(TunnelRuleSchema.safeParse({
      direction: 'local', bindHost: '0.0.0.0', bindPort: 8080,
      targetHost: '127.0.0.1', targetPort: 80, publicBindConfirmed: false,
    }).success).toBe(false);
    expect(TunnelRuleSchema.safeParse({
      direction: 'local', bindHost: '0.0.0.0', bindPort: 8080,
      targetHost: '127.0.0.1', targetPort: 80, publicBindConfirmed: true,
    }).success).toBe(true);
  });

  it('validates remote Unix socket paths structurally', () => {
    expect(RemoteSocketPathSchema.parse('/run/docker.sock')).toBe('/run/docker.sock');
    expect(RemoteSocketPathSchema.safeParse('../docker.sock').success).toBe(false);
  });
});
