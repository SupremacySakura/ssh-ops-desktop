import { describe, expect, it } from 'vitest';

import { MonitorSnapshotSchema } from './monitor.js';

const snapshot = {
  timestamp: '2026-11-17T12:34:56.789Z',
  cpuPercent: 42.5,
  memory: {
    totalBytes: 8_000,
    availableBytes: 3_000,
    usedBytes: 5_000,
  },
  disk: {
    filesystem: '/dev/vda1',
    totalBytes: 100_000,
    usedBytes: 40_000,
    availableBytes: 60_000,
    mountPoint: '/',
  },
  load: {
    one: 0.25,
    five: 0.5,
    fifteen: 0.75,
  },
  uptimeSeconds: 123_456,
  topProcesses: [{
    pid: 42,
    user: 'deploy',
    name: 'nginx worker',
    cpuPercent: 125.5,
    memoryPercent: 3.25,
  }],
  unavailable: ['processes_partial'],
} as const;

describe('Monitoring snapshot contract', () => {
  it('parses the Rust camelCase shape and preserves process percentages above 100', () => {
    expect(MonitorSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });

  it('represents the first CPU sample as absent with a warming-up code', () => {
    const first = {
      ...snapshot,
      cpuPercent: undefined,
      unavailable: ['cpu_warming_up'],
    };
    expect(MonitorSnapshotSchema.parse(first)).toEqual(first);
  });

  it('rejects unknown fields, invalid percentages, and unstable unavailable codes', () => {
    expect(MonitorSnapshotSchema.safeParse({
      ...snapshot,
      cpuPercent: 101,
    }).success).toBe(false);
    expect(MonitorSnapshotSchema.safeParse({
      ...snapshot,
      extra: true,
    }).success).toBe(false);
    expect(MonitorSnapshotSchema.safeParse({
      ...snapshot,
      unavailable: ['cpu_from_the_future'],
    }).success).toBe(false);
    expect(MonitorSnapshotSchema.safeParse({
      ...snapshot,
      topProcesses: [{ ...snapshot.topProcesses[0], pid: 0 }],
    }).success).toBe(false);
  });
});
