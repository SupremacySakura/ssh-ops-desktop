import { describe, expect, it } from 'vitest';

import { DeployRunArgsSchema, GitRevisionSchema } from './deploy.js';

describe('deployment contracts', () => {
  it('rejects option injection and traversal revisions', () => {
    expect(GitRevisionSchema.safeParse('--upload-pack=pwn').success).toBe(false);
    expect(GitRevisionSchema.safeParse('release/../main').success).toBe(false);
    expect(GitRevisionSchema.parse('release/v1.2.3')).toBe('release/v1.2.3');
  });

  it('binds a deployment to connection and project identifiers', () => {
    expect(DeployRunArgsSchema.parse({
      connection: {
        serverId: '019c62b2-2970-7000-8000-000000000003',
        connectionId: '019c62b2-2970-7000-8000-000000000004',
      },
      projectId: '019c62b2-2970-7000-8000-000000000005',
      revision: 'main',
    }).revision).toBe('main');
  });
});
