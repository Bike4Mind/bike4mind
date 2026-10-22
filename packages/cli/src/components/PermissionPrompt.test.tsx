import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { PermissionPrompt, escapeTerminalControlChars } from './PermissionPrompt';

const tick = () => new Promise(resolve => setTimeout(resolve, 60));

// Built at runtime so the source stays ASCII (see FolderTrustPrompt.test.tsx).
const ARROW_DOWN = String.fromCharCode(27) + '[B';
const ENTER = '\r';

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

  it('escapes Unicode bidi overrides and isolates that reorder displayed glyphs', () => {
    const spoof = 'allow\u202edeled'; // U+202E (RLO) makes the tail render reversed
    const escaped = escapeTerminalControlChars(spoof);
    expect(escaped).not.toContain('\u202e');
    expect(escaped).toContain('\\u202e');
    expect(escapeTerminalControlChars('a\u2066b')).toContain('\\u2066'); // isolate boundary
  });

  it('escapes C1 controls such as the 8-bit CSI', () => {
    const escaped = escapeTerminalControlChars('a\u009b2Kb\u0085c');
    expect(escaped).toBe('a\\x9b2Kb\\x85c');
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

  it('escapes a bidi override in the rendered args', () => {
    const { lastFrame } = render(
      <PermissionPrompt toolName="create_file" args={'safe\u202eSPOOFED'} canBeTrusted onResponse={() => {}} />
    );
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('\\u202e');
    expect(frame).not.toContain('\u202e');
  });

  it('escapes the tool name and description', () => {
    const { lastFrame } = render(
      <PermissionPrompt
        toolName={'mcp_tool\u202eevil'}
        toolDescription={'read file\rdelete file'}
        args={{}}
        canBeTrusted
        onResponse={() => {}}
      />
    );
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('mcp_tool\\u202eevil');
    expect(frame).toContain('read file\\x0ddelete file');
    expect(frame).not.toContain('\r');
  });
});

describe('PermissionPrompt sandbox escalation menu', () => {
  function renderEscalation(onResponse: () => void) {
    return render(
      <PermissionPrompt
        toolName="bash_execute"
        args={{ command: 'touch /etc/hosts' }}
        kind="sandbox-escalation"
        canBeTrusted
        onResponse={onResponse}
      />
    );
  }

  it('offers retry-once, allow-for-session and deny, and never "Always allow"', () => {
    const { lastFrame } = renderEscalation(() => {});
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('Retry once without sandbox');
    expect(frame).toContain('Allow this command unsandboxed for the session');
    expect(frame).toContain('Deny');
    expect(frame).not.toContain('Always allow');
  });

  it('maps the three items to allow-once, allow-session and deny', async () => {
    const allowOnce = vi.fn();
    const once = renderEscalation(allowOnce);
    await tick();
    once.stdin.write(ENTER);
    await tick();
    expect(allowOnce).toHaveBeenCalledWith('allow-once');

    const allowSession = vi.fn();
    const session = renderEscalation(allowSession);
    await tick();
    session.stdin.write(ARROW_DOWN);
    await tick();
    session.stdin.write(ENTER);
    await tick();
    expect(allowSession).toHaveBeenCalledWith('allow-session');

    const deny = vi.fn();
    const denied = renderEscalation(deny);
    await tick();
    denied.stdin.write(ARROW_DOWN);
    await tick();
    denied.stdin.write(ARROW_DOWN);
    await tick();
    denied.stdin.write(ENTER);
    await tick();
    expect(deny).toHaveBeenCalledWith('deny');
  });
});
