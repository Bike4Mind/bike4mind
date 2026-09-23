import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { PermissionPrompt, escapeTerminalControlChars } from './PermissionPrompt';

// Strip styling ANSI before the negative frame assertions so they test only "the
// component did not escape the arg", not "colour is off". The rendered prompt is
// full of SGR sequences once chalk decides the stream supports colour (e.g. under
// FORCE_COLOR=1), and each starts with a raw ESC byte that would otherwise trip
// `not.toContain('\x1b')`. Mirrors App.resize.test.tsx / MessageItem.*.test.tsx.
// eslint-disable-next-line no-control-regex
const stripAnsi = (value: string) => value.replace(/\x1b\[[0-9;]*m/g, '');

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

// String args pass through raw (typeof args === 'string'), so a raw control
// byte reaches the renderer untouched - unlike object args, which JSON.stringify
// already neutralizes. These render tests cover that raw-byte path.
describe('PermissionPrompt Arguments block', () => {
  it('escapes a carriage return in the rendered args so it cannot spoof the displayed row', () => {
    const { lastFrame } = render(
      <PermissionPrompt toolName="create_file" args={'safe\rSPOOFED'} canBeTrusted onResponse={() => {}} />
    );
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('\\x0d');
    expect(frame).not.toContain('\r');
  });

  it('escapes an ESC byte in the rendered args', () => {
    const { lastFrame } = render(
      <PermissionPrompt toolName="create_file" args={'safe\x1bSPOOFED'} canBeTrusted onResponse={() => {}} />
    );
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('\\x1b');
    expect(frame).not.toContain('\x1b');
  });
});
