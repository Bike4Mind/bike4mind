import { WEB_FETCH_TOOL_NAME, WEB_SEARCH_TOOL_NAME } from '@shared/webSearch';
import { MCP_TOOL_PREFIX } from '../mcp/names';

/**
 * Tools that ask in EVERY mode, including 'full'.
 *
 * These are gated on cost, not on filesystem risk, and the two are separate axes on purpose:
 * a user who has decided the agent may edit their files and run their build has said nothing
 * about spending credits on image generation or on starting an autonomous session.
 *
 * `session_send` is deliberately NOT here, though the turn it starts does cost credits. The
 * cycle it could run away with is already bounded in code - MAX_MESSAGE_HOPS on the chain and
 * MAX_SENDS_PER_TURN on the fan, so a user turn caps out at 14 relayed turns whatever the
 * agents do - and a per-send click on top of that bound only stops the autonomy the feature
 * exists for: a session that has finished its work sits waiting for a human purely to hand its
 * summary back. It rides the approval mode like any other tool instead, so 'ask' still asks
 * about every message and 'auto'/'full' let the chain run inside its structural bound.
 */
const SPENDS_CREDITS: ReadonlySet<string> = new Set([
  'generate_image',
  'generate_speech',
  'generate_sound_effect',
  'generate_music',
  'generate_video',
  'session_spawn',
]);

export function spendsCredits(toolName: string): boolean {
  return SPENDS_CREDITS.has(toolName);
}

/**
 * Tools whose result is someone else's text - a web page, an MCP server, a skill, or another
 * session's transcript, which may have read any of those - that can carry injected instructions.
 *
 * A shell command's output is NOT here, even though `curl` prints what a page said: a script
 * file or a decoded payload slips past any check on the text, so a command is judged on what it
 * can do (see shellScan) rather than on what it printed.
 *
 * `browser_*` and every server tool are matched by prefix, so a new one is covered as it ships.
 */
const READS_UNTRUSTED: ReadonlySet<string> = new Set([
  WEB_FETCH_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  'skill',
  'session_read',
]);

export function readsUntrusted(toolName: string): boolean {
  return READS_UNTRUSTED.has(toolName) || toolName.startsWith('browser_') || toolName.startsWith(MCP_TOOL_PREFIX);
}

/**
 * Tools that can carry data off this computer, or into a session that has not read the untrusted
 * content. A reply that has read such content asks before each of these, whatever "always" was
 * answered before.
 */
const SENDS_OUT: ReadonlySet<string> = new Set([
  'bash_execute',
  'bash_background',
  WEB_FETCH_TOOL_NAME,
  'browser_navigate',
  'browser_tabs',
  'session_send',
]);

export function sendsOut(toolName: string): boolean {
  return SENDS_OUT.has(toolName) || toolName.startsWith(MCP_TOOL_PREFIX);
}
