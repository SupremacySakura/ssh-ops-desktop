import { describe, expect, it } from 'vitest';

import { NginxApplyArgsSchema } from './nginx.js';

describe('Nginx contracts', () => {
  const input = {
    connection: {
      serverId: '019c62b2-2970-7000-8000-000000000003',
      connectionId: '019c62b2-2970-7000-8000-000000000004',
    },
    livePath: '/etc/nginx/conf.d/web.conf',
    mainConfigPath: '/etc/nginx/nginx.conf',
    candidate: 'server { listen 80; }',
    confirmationTarget: '/etc/nginx/conf.d/web.conf',
  };

  it('binds typed confirmation to the live configuration path', () => {
    expect(NginxApplyArgsSchema.parse(input).livePath).toBe(input.livePath);
    expect(NginxApplyArgsSchema.safeParse({
      ...input,
      confirmationTarget: '/etc/nginx/conf.d/other.conf',
    }).success).toBe(false);
  });

  it('rejects traversal paths and NUL candidates', () => {
    expect(NginxApplyArgsSchema.safeParse({ ...input, livePath: '/etc/nginx/../passwd' }).success).toBe(false);
    expect(NginxApplyArgsSchema.safeParse({ ...input, candidate: 'server {}\0' }).success).toBe(false);
  });
});
