import { describe, expect, it } from 'vitest';

import {
  commandAppearsInTerminalEcho,
  trackExecutedCommands,
} from './command-tracking';

describe('terminal command tracking', () => {
  it('records commands submitted by Enter and ignores control sequences', () => {
    const state = { current: '', inEscape: false };

    expect(trackExecutedCommands('\u001b[A', state)).toEqual([]);
    expect(trackExecutedCommands('echo hello\r', state)).toEqual(['echo hello']);
    expect(trackExecutedCommands('\u001bOP', state)).toEqual([]);
    expect(trackExecutedCommands('docker ps\n', state)).toEqual(['docker ps']);
  });

  it('tracks backspace, cancellation, and command insertion', () => {
    const state = { current: '', inEscape: false };

    expect(trackExecutedCommands('ecxo\u007fho\u0003ls -la\r', state)).toEqual([
      'ls -la',
    ]);
    const commands = trackExecutedCommands('echo --color\u0015uptime\r', state);

    expect(commands).toEqual(['uptime']);
    expect(trackExecutedCommands('   \r', state)).toEqual([]);
  });

  it('only records a command after its own echo extends the prompt line', () => {
    expect(commandAppearsInTerminalEcho(
      'deploy@prod:~$ ',
      'deploy@prod:~$ sudo systemctl restart nginx',
      'sudo systemctl restart nginx',
    )).toBe(true);
    expect(commandAppearsInTerminalEcho(
      '[sudo] password for deploy:',
      '[sudo] password for deploy:',
      'deploy',
    )).toBe(false);
    expect(commandAppearsInTerminalEcho(
      '[sudo] password for deploy: ',
      '[sudo] password for deploy: deploy',
      'deploy',
    )).toBe(false);
    expect(commandAppearsInTerminalEcho(
      'Last successful login: deploy',
      'Last successful login: deploy',
      'deploy',
    )).toBe(false);
    expect(commandAppearsInTerminalEcho(
      'deploy@prod:~$ ',
      'deploy@prod:~$ echo deploy@prod',
      'deploy',
    )).toBe(false);
    expect(commandAppearsInTerminalEcho(
      '',
      'echo without-a-prompt',
      'echo without-a-prompt',
    )).toBe(true);
    expect(commandAppearsInTerminalEcho('', '', 'hidden-password')).toBe(false);
  });
});
