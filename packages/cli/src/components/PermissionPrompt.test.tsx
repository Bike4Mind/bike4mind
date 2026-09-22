import { describe, it, expect } from 'vitest';
import { escapeTerminalControlChars } from './PermissionPrompt';

describe('escapeTerminalControlChars', () => {
  it('escapes carriage returns so a preview cannot rewrite the displayed line', () => {
    const spoof = 'rm -rf /tmp/safe\rrm -rf /';
    const escaped = escapeTerminalControlChars(spoof);
    expect(escaped).not.toContain('\r');
    expect(escaped).toContain('\\x0d');
  });

  it('escapes ESC/ANSI sequences', () => {
    const escaped = escapeTerminalControlChars('text\x1b[2Kmore');
    expect(escaped).not.toContain('\x1b');
    expect(escaped).toContain('\\x1b');
  });

  it('leaves ordinary text, tabs and newlines intact', () => {
    const text = 'line one\n\tindented\nline two';
    expect(escapeTerminalControlChars(text)).toBe(text);
  });
});
