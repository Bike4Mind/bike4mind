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
 * MAX_SENDS_PER_TURN on the fan, so a user turn caps out at 62 relayed turns whatever the
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
 * A skill the user installed or a trusted project's opts out per call; see skillTool's `run`.
 *
 * A shell command's output is NOT here, even though `curl` prints what a page said: a script
 * file or a decoded payload slips past any check on the text, so a command is judged on what it
 * can do (see shellScan) rather than on what it printed.
 *
 * `screen_capture` is here because a window can show anything - a web page, an email, a chat -
 * and text in an image steers a model as well as text does. A `file_read` of an image is not:
 * it is a file in a folder the user shared, judged like the text files beside it.
 *
 * `browser_*` and every server tool are matched by prefix, so a new one is covered as it ships.
 */
const READS_UNTRUSTED: ReadonlySet<string> = new Set([
  WEB_FETCH_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  'skill',
  'session_read',
  'screen_capture',
]);

export function readsUntrusted(toolName: string): boolean {
  return READS_UNTRUSTED.has(toolName) || toolName.startsWith('browser_') || toolName.startsWith(MCP_TOOL_PREFIX);
}

/**
 * Tools that can carry data off this computer, or into a session that has not read the untrusted
 * content. A reply that has read such content asks before each of these, whatever "always" was
 * answered before - except a shell command the scan proved contained (ApprovalPrompt.contained).
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

/**
 * Tools whose "Allow in this chat" covers them over a tainted reply too, as an allow
 * rule does. Taint makes web_fetch ask because an injected page could pick the URL; a user who
 * answered "always" for every site has already accepted any URL, so asking per site in a
 * tainted reply only stacks a card for each parallel fetch.
 */
const ALWAYS_OVERRIDES_TAINT: ReadonlySet<string> = new Set([WEB_FETCH_TOOL_NAME]);

export function alwaysOverridesTaint(toolName: string): boolean {
  return ALWAYS_OVERRIDES_TAINT.has(toolName);
}
