import type { TerminalDataEvent } from '@opspilot/contracts';

export interface TerminalViewSession {
  id: string;
  serverId: string;
  title: string;
  output: string;
  lastSequence: number;
  outputMayHaveGap: boolean;
}

export function createTerminalSessionStore() {
  const sessions = new Map<string, TerminalViewSession>();
  const decoder = new TextDecoder();
  return {
    open(id: string, serverId: string, title: string) {
      sessions.set(id, { id, serverId, title, output: '', lastSequence: 0, outputMayHaveGap: false });
    },
    close(id: string) { sessions.delete(id); },
    get(id: string) { return sessions.get(id); },
    list() { return [...sessions.values()]; },
    accept(event: TerminalDataEvent): 'accepted' | 'old' | 'gap' | 'unknown' {
      const session = sessions.get(event.terminalSessionId);
      if (!session) return 'unknown';
      if (event.sequence <= session.lastSequence) return 'old';
      const gap = event.sequence > session.lastSequence + 1;
      session.lastSequence = event.sequence;
      session.outputMayHaveGap ||= gap;
      session.output += decoder.decode(Uint8Array.from(event.bytes), { stream: true });
      return gap ? 'gap' : 'accepted';
    },
    markAllGapped() {
      for (const session of sessions.values()) session.outputMayHaveGap = true;
    },
  };
}

export type TerminalSessionStore = ReturnType<typeof createTerminalSessionStore>;
