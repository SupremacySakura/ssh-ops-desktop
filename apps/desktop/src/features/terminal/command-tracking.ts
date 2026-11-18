export interface CommandTrackingState {
  current: string;
  inEscape: boolean;
}

const SECRET_PROMPT_PATTERN = (
  /\b(?:password|passphrase|passcode|token|secret)\b|密码|口令|私钥/iu
);

export function commandAppearsInTerminalEcho(
  baselineLine: string,
  currentLine: string,
  command: string,
): boolean {
  const normalizedBaseline = normalizeForEcho(baselineLine);
  const normalizedLine = normalizeForEcho(currentLine);
  const normalizedCommand = normalizeForEcho(command);
  if (
    normalizedCommand.length === 0
    || normalizedLine === normalizedBaseline
    || !normalizedLine.startsWith(normalizedBaseline)
    || SECRET_PROMPT_PATTERN.test(normalizedBaseline)
  ) {
    return false;
  }
  return normalizedLine.slice(normalizedBaseline.length).trim() === normalizedCommand;
}

export function trackExecutedCommands(
  text: string,
  state: CommandTrackingState,
): string[] {
  const commands: string[] = [];
  for (const character of text) {
    if (state.inEscape) {
      if (character === '[' || character === 'O') continue;
      if (character >= '@' && character <= '~') state.inEscape = false;
      continue;
    }
    if (character === '\u001b') {
      state.inEscape = true;
      continue;
    }
    if (character === '\r' || character === '\n') {
      const command = state.current.trim();
      if (command.length > 0) commands.push(command);
      state.current = '';
      continue;
    }
    if (character === '\u007f' || character === '\b') {
      state.current = state.current.slice(0, -1);
      continue;
    }
    if (character === '\u0003' || character === '\u0015') {
      state.current = '';
      continue;
    }
    if (character >= ' ') state.current += character;
  }
  return commands;
}

function normalizeForEcho(value: string): string {
  return value
    .replaceAll('\r', '')
    .replaceAll(/\s+/gu, ' ')
    .trim();
}
