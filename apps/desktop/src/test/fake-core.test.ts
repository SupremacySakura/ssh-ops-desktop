import type { Server, ServerInput } from '@opspilot/contracts';
import { describe, expect, it } from 'vitest';

import { createFakeCoreClient } from './fake-core';

const pendingServer: Server = {
  id: '019c62b2-2970-7000-8000-000000000050',
  name: 'pending',
  host: 'pending.example.com',
  port: 22,
  user: 'deploy',
  authType: 'key',
  secretRef: null,
  groupId: null,
  favorite: false,
  lastConnectedAt: null,
  createdAt: 1_700_000_000,
};

const input: ServerInput = {
  name: pendingServer.name,
  host: pendingServer.host,
  port: pendingServer.port,
  user: pendingServer.user,
  authType: 'password',
  groupId: null,
  favorite: false,
};

describe('FakeCoreClient security parity', () => {
  it('fails closed when a pending credential is connected', async () => {
    const core = createFakeCoreClient({ servers: [pendingServer] });

    await expect(core.connect(pendingServer.id)).rejects.toMatchObject({
      code: 'SECRET_UNAVAILABLE',
    });
  });

  it('requires a new credential when the authentication type changes', async () => {
    const core = createFakeCoreClient({
      servers: [{ ...pendingServer, secretRef: 'secret-ref-fixture' }],
    });

    await expect(core.updateServer(pendingServer.id, input)).rejects.toMatchObject({
      code: 'VALIDATION',
    });
  });
});
