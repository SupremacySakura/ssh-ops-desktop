import { describe, expect, it } from 'vitest';

import {
  createMemoryCommandHistory,
  fuzzyCommandScore,
} from './command-history';

describe('terminal command history', () => {
  it('isolates history by server and returns the most recent commands first', async () => {
    let now = 1_700_000_000_000;
    const history = createMemoryCommandHistory(() => now);

    await history.add('server-a', 'systemctl status nginx');
    now += 1_000;
    await history.add('server-a', 'docker ps');
    now += 1_000;
    await history.add('server-b', 'systemctl restart nginx');

    await expect(history.search('server-a', '')).resolves.toEqual([
      expect.objectContaining({ command: 'docker ps', serverId: 'server-a' }),
      expect.objectContaining({ command: 'systemctl status nginx', serverId: 'server-a' }),
    ]);
    await expect(history.search('server-b', 'nginx')).resolves.toEqual([
      expect.objectContaining({ command: 'systemctl restart nginx', serverId: 'server-b' }),
    ]);
  });

  it('fuzzy matches substrings before subsequences and is case insensitive', async () => {
    let now = 1_700_000_000_000;
    const history = createMemoryCommandHistory(() => now);

    await history.add('server-a', 'journalctl -u ssh --since today');
    now += 1_000;
    await history.add('server-a', 'docker compose logs web');
    now += 1_000;
    await history.add('server-a', 'echo dcl-token');

    const results = await history.search('server-a', 'dcl');
    expect(results).toHaveLength(2);
    expect(results[0]?.command).toBe('echo dcl-token');
    expect(fuzzyCommandScore('dcl', 'DOcker Compose Logs')).toBeGreaterThan(0);
    expect(fuzzyCommandScore('zzz', 'docker ps')).toBe(-1);
  });

  it('rejects empty commands and respects the search limit', async () => {
    const history = createMemoryCommandHistory(() => 1_700_000_000_000);

    await expect(history.add('server-a', '   ')).rejects.toThrow();
    for (let index = 0; index < 5; index += 1) {
      await history.add('server-a', `echo ${index}`);
    }

    await expect(history.search('server-a', 'echo', 2)).resolves.toHaveLength(2);
  });
});
