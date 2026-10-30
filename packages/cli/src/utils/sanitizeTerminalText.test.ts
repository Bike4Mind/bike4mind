import { describe, it, expect } from 'vitest';
import { sanitizeTerminalText, escapeTerminalControlChars } from './sanitizeTerminalText';

const ESC = '\x1b';
const BEL = '\x07';
const ST = `${ESC}\\`;

describe('sanitizeTerminalText', () => {
  it.each([
    ['SGR colour injection', `a${ESC}[31mred${ESC}[0mb`, 'aredb'],
    ['cursor movement and erase', `ok${ESC}[2A${ESC}[2K${ESC}[1;1Hspoof`, 'okspoof'],
    ['private-mode switch (alt screen)', `x${ESC}[?1049hy`, 'xy'],
    ['8-bit CSI', 'a\u009b2Kb', 'ab'],
    ['OSC 0 title change, BEL-terminated', `${ESC}]0;pwned${BEL}text`, 'text'],
    ['OSC 2 title change, ST-terminated', `${ESC}]2;pwned${ST}text`, 'text'],
    ['OSC 52 clipboard write', `x${ESC}]52;c;cm0gLXJmIH4=${BEL}y`, 'xy'],
    ['OSC 8 hyperlink keeps only the label', `${ESC}]8;;https://evil.example${ST}click${ESC}]8;;${ST}`, 'click'],
    ['8-bit OSC with 8-bit ST', 'a\u009d0;t\u009cb', 'ab'],
    ['DCS sequence', `a${ESC}Pq#0;2;0;0;0${ST}b`, 'ab'],
    ['APC (kitty graphics) sequence', `a${ESC}_Gf=100;AAAA${ST}b`, 'ab'],
    ['two-byte ESC reset', `a${ESC}cb`, 'ab'],
    ['charset select with intermediate', `a${ESC}(0b`, 'ab'],
    ['lone ESC at end', `text${ESC}`, 'text'],
    ['unterminated CSI keeps its params as text', `a${ESC}[31`, 'a31'],
    ['unterminated OSC keeps its payload visible', `a${ESC}]0;title`, 'a0;title'],
    ['NUL, BEL and backspace', 'a\x00b\x07c\x08d', 'abcd'],
    ['bare carriage return that would overwrite the line', 'safe\rspoof', 'safespoof'],
    ['CRLF becomes LF', 'one\r\ntwo', 'one\ntwo'],
    ['DEL and C1 NEL', 'a\x7fb\u0085c', 'abc'],
    ['vertical tab and form feed', 'a\x0bb\x0cc', 'abc'],
    ['bidi override spoofing', 'invoice\u202Efdp.exe', 'invoicefdp.exe'],
    ['bidi embeddings and isolates', '\u202Aa\u202Bb\u202Cc\u202Dd\u2066e\u2067f\u2068g\u2069', 'abcdefg'],
    ['bidi marks LRM, RLM and ALM', 'a\u200Eb\u200Fc\u061Cd', 'abcd'],
  ])('strips %s', (_label, input, expected) => {
    expect(sanitizeTerminalText(input)).toBe(expected);
  });

  it.each([
    ['plain ASCII with tabs and newlines', 'line one\n\tindented\nline two'],
    ['CJK', '\u65E5\u672C\u8A9E\u306E\u30C6\u30AD\u30B9\u30C8 \u4E2D\u6587 \uD55C\uAD6D\uC5B4'],
    ['emoji incl. ZWJ sequences and skin tones', '\u{1F469}\u200D\u{1F4BB} \u{1F44D}\u{1F3FD} \u{1F1EF}\u{1F1F5}'],
    ['right-to-left text without overrides', '\u05E9\u05DC\u05D5\u05DD \u0645\u0631\u062D\u0628\u0627'],
    ['accents and combining marks', 'cafe\u0301 na\u00EFve \u00E9t\u00E9'],
    ['markdown and code', '# Title\n\n```ts\nconst x = a[0] ?? "]";\n```\n- [link](https://x.y)'],
  ])('leaves %s unchanged', (_label, input) => {
    expect(sanitizeTerminalText(input)).toBe(input);
  });

  it('strips a very long CSI parameter run whole', () => {
    expect(sanitizeTerminalText(`a${ESC}[${'1;'.repeat(100_000)}mb`)).toBe('ab');
  });

  it('stays linear on many unterminated sequences', () => {
    const hostile = `${ESC}]${'x'.repeat(10)}`.repeat(50_000) + '\u0090'.repeat(50_000);
    const started = performance.now();
    const out = sanitizeTerminalText(hostile);
    expect(performance.now() - started).toBeLessThan(1_000);
    // eslint-disable-next-line no-control-regex
    expect(out).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
  });

  it('never leaves a control character behind, whatever the input', () => {
    let input = '';
    for (let code = 0; code <= 0xa0; code++) input += String.fromCharCode(code) + '[0;1m]x';
    // eslint-disable-next-line no-control-regex
    const residue = /[\x00-\x08\x0b-\x1f\x7f-\x9f\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/;
    expect(sanitizeTerminalText(input)).not.toMatch(residue);
  });
});

describe('escapeTerminalControlChars', () => {
  it('escapes carriage returns so a preview cannot rewrite the displayed line', () => {
    const spoof = 'rm -rf /tmp/safe\rrm -rf /';
    const escaped = escapeTerminalControlChars(spoof);
    expect(escaped).not.toContain('\r');
    expect(escaped).toContain('\\x0d');
  });

  it('escapes ESC/ANSI sequences', () => {
    const escaped = escapeTerminalControlChars('text\x1b[2Kmore');
    expect(escaped).toBe('text\\x1b[2Kmore');
  });

  it('escapes Unicode bidi overrides and isolates that reorder displayed glyphs', () => {
    const spoof = 'allow\u202Edeled'; // U+202E (RLO) makes the tail render reversed
    const escaped = escapeTerminalControlChars(spoof);
    expect(escaped).not.toContain('\u202E');
    expect(escaped).toContain('\\u202e');
    expect(escapeTerminalControlChars('a\u2066b')).toContain('\\u2066'); // isolate boundary
  });

  it('escapes C1 controls such as the 8-bit CSI', () => {
    const escaped = escapeTerminalControlChars('a\u009b2Kb\u0085c');
    expect(escaped).toBe('a\\x9b2Kb\\x85c');
  });

  it('keeps bidi marks only when keepBidiMarks is set, and still escapes overrides', () => {
    expect(escapeTerminalControlChars('a\u200Fb', { keepBidiMarks: true })).toBe('a\u200Fb');
    expect(escapeTerminalControlChars('a\u202Eb', { keepBidiMarks: true })).toBe('a\\u202eb');
    expect(escapeTerminalControlChars('a\u200Fb')).toBe('a\\u200fb');
  });

  it('leaves ordinary text, tabs and newlines intact', () => {
    const text = 'line one\n\tindented\nline two';
    expect(escapeTerminalControlChars(text)).toBe(text);
  });
});
