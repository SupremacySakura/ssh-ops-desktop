import type {
  ConnectionHandle,
  RemoteFileEntry,
  Server,
  ServerInput,
} from '@opspilot/contracts';
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
const connection: ConnectionHandle = {
  serverId: pendingServer.id,
  connectionId: '019c62b2-2970-7000-8000-000000000051',
};
const fileHash = '5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03';
const fileEntry: RemoteFileEntry = {
  name: 'app.conf',
  path: '/srv/app.conf',
  kind: 'file',
  size: 6,
  modifiedAt: 42,
  permissions: 0o640,
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

  it('provides a conflict-safe in-memory file surface for UI tests', async () => {
    const core = createFakeCoreClient({
      files: {
        entriesByDirectory: {
          '/': [fileEntry],
        },
        documents: {
          [fileEntry.path]: {
            path: fileEntry.path,
            text: 'hello\n',
            sha256: fileHash,
            size: 6,
            modifiedAt: 42,
          },
        },
        downloads: {
          [fileEntry.path]: {
            path: fileEntry.path,
            bytes: [104, 101, 108, 108, 111, 10],
            sha256: fileHash,
          },
        },
      },
    });

    await expect(core.listFiles(connection, '/')).resolves.toEqual([fileEntry]);
    await expect(core.readFile(connection, fileEntry.path)).resolves.toMatchObject({
      text: 'hello\n',
      sha256: fileHash,
    });
    await expect(core.writeFile(
      connection,
      fileEntry.path,
      'draft\n',
      'a'.repeat(64),
    )).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(core.readFile(connection, fileEntry.path)).resolves.toMatchObject({
      text: 'hello\n',
    });

    const saved = await core.writeFile(
      connection,
      fileEntry.path,
      'next\n',
      fileHash,
    );
    await expect(core.readFile(connection, fileEntry.path)).resolves.toMatchObject({
      text: 'next\n',
      sha256: saved.sha256,
    });
    await expect(core.downloadFile(connection, fileEntry.path)).resolves.toMatchObject({
      bytes: [104, 101, 108, 108, 111, 10],
    });
  });
});
