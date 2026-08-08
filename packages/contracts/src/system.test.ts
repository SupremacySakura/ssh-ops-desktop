import { describe, expect, it } from 'vitest';

import { LinuxMetricsSchema, ServiceActionArgsSchema, ServiceActionSchema, SystemOverviewSchema } from './system.js';

describe('system contracts', () => {
  it('keeps partial metric failures explicit', () => {
    const metrics = LinuxMetricsSchema.parse({
      timestamp: '2026-08-08T12:00:00.000Z',
      memory: { totalBytes: 1_000, availableBytes: 250, usedBytes: 750 },
      unavailable: ['network'],
      disks: [],
    });
    expect(metrics.unavailable).toEqual(['network']);
  });

  it('validates service actions and overview environment', () => {
    expect(ServiceActionSchema.parse('restart')).toBe('restart');
    expect(SystemOverviewSchema.parse({
      serverId: '019c62b2-2970-7000-8000-000000000003',
      environment: 'production',
      os: { id: 'ubuntu', versionId: '24.04', prettyName: 'Ubuntu', serviceManager: 'systemd' },
    }).environment).toBe('production');
  });

  it('rejects shell payloads in systemd unit names', () => {
    const connection = {
      serverId: '019c62b2-2970-7000-8000-000000000003',
      connectionId: '019c62b2-2970-7000-8000-000000000004',
    };
    expect(ServiceActionArgsSchema.safeParse({ connection, unit: 'nginx.service' }).success).toBe(true);
    expect(ServiceActionArgsSchema.safeParse({ connection, unit: 'nginx.service;reboot' }).success).toBe(false);
  });
});
