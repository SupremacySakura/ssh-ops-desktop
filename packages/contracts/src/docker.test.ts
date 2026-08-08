import { describe, expect, it } from 'vitest';

import { ContainerIdentifierSchema, DockerContainerActionArgsSchema } from './docker.js';

describe('Docker contracts', () => {
  it('rejects option-like container identifiers', () => {
    expect(ContainerIdentifierSchema.safeParse('--host=tcp://evil').success).toBe(false);
    expect(ContainerIdentifierSchema.parse('web-1')).toBe('web-1');
  });

  it('binds write actions to an existing SSH connection', () => {
    expect(DockerContainerActionArgsSchema.parse({
      connection: {
        serverId: '019c62b2-2970-7000-8000-000000000003',
        connectionId: '019c62b2-2970-7000-8000-000000000004',
      },
      container: 'web-1',
    }).container).toBe('web-1');
  });
});
