/**
 * The one escaping layer for untrusted text written to the terminal: model
 * output (replies, thoughts, tool arguments), tool and MCP results, file names
 * and paths, history entries, and error messages from remote services.
 *
 * Display only. Apply it at the render site, never to text sent to the model,
 * stored in the transcript, or parsed for input (image-paste detection needs
 * the raw escapes). The CLI's own styling (Ink color props, cli-highlight,
 * hardcoded SGR codes) is applied after sanitizing, so it is unaffected.
 *
 * Two modes:
 *   - sanitizeTerminalText strips: for flowing content such as replies and
 *     tool output, where the hostile bytes are noise.
 *   - escapeTerminalControlChars makes them visible as `\xHH` / `\uHHHH`: for
 *     approval prompts, where the user must see exactly what they approve.
 * Guarded by sanitizeTerminalText.test.ts (hostile-input table) and
 * terminalRenderSites.test.tsx (render sites that must route through here).
 */

// ESC-introduced sequences are removed whole, so their parameter bytes do not
// survive as stray text:
//   - CSI: `ESC [` or 8-bit U+009B, params, intermediates, final byte
//     (cursor moves, erase, scroll, SGR, mode switches).
//   - String sequences: OSC (`ESC ]`, incl. OSC 8 hyperlinks, OSC 52 clipboard
//     writes, OSC 0/2 title changes), DCS, SOS, PM and APC, each in 7-bit and
//     8-bit form, ended by BEL, `ESC \` or 8-bit ST. The body excludes every
//     introducer and terminator, so a scan stops at the next one and stays
//     linear on input with many unterminated sequences.
//   - Any other ESC + intermediates + final byte (`ESC c` reset, `ESC 7`,
//     charset selects like `ESC ( 0`).
// An unterminated string sequence loses only its introducer: its payload stays
// visible as plain text rather than hiding the rest of the output, which is
// what a terminal would do and what an attacker would want.
const ESCAPE_SEQUENCE =
  // eslint-disable-next-line no-control-regex
  /(?:\x1b\[|\x9b)[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]|(?:\x1b[\]PX^_]|[\x90\x98\x9d\x9e\x9f])[^\x07\x1b\x90\x98\x9c-\x9f]*(?:\x07|\x1b\\|\x9c)|\x1b[\x20-\x2f]*[\x30-\x7e]/g;

// What remains after whole sequences are gone: C0 controls except tab and
// newline (a lone ESC, NUL, BEL, backspace, a bare `\r` that would overwrite the
// line), DEL, C1 controls, and the bidi controls that reorder displayed glyphs
// without changing the underlying code points: embeddings/overrides
// U+202A..U+202E, isolates U+2066..U+2069, and the marks U+061C, U+200E, U+200F
// (weaker, but they still move neutral characters such as a filename's dot).
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR = /[\x00-\x08\x0b-\x1f\x7f-\x9f\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

// Same set minus the three bidi marks, for prose where legitimate RTL text carries them.
// eslint-disable-next-line no-control-regex
const PROSE_CONTROL_CHAR = /[\x00-\x08\x0b-\x1f\x7f-\x9f\u202A-\u202E\u2066-\u2069]/g;

/** Strip terminal control sequences and characters from untrusted text for display. */
export function sanitizeTerminalText(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(ESCAPE_SEQUENCE, '').replace(CONTROL_CHAR, '');
}

/**
 * Escape the same control characters into a visible form instead of removing
 * them. ESC becomes `\x1b`, so a whole sequence reads as e.g. `\x1b[2K` and
 * cannot act. Tab and newline are left intact.
 */
export function escapeTerminalControlChars(text: string, opts: { keepBidiMarks?: boolean } = {}): string {
  return text.replace(opts.keepBidiMarks ? PROSE_CONTROL_CHAR : CONTROL_CHAR, ch => {
    const code = ch.charCodeAt(0);
    return code > 0xff ? `\\u${code.toString(16).padStart(4, '0')}` : `\\x${code.toString(16).padStart(2, '0')}`;
  });
}
