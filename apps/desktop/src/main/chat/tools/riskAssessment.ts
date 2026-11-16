import { WEB_FETCH_TOOL_NAME, WEB_SEARCH_TOOL_NAME } from '@shared/webSearch';
import { MCP_TOOL_PREFIX } from '../mcp/names';

/**
 * Tools that spend credits beyond the chat turn itself. Not an approval gate: they ride the
 * approval mode like any other tool, as every chat turn spends credits too. The capability
 * ledger files their grants under 'credits'; see capabilityFor.
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

/** External text or imagery can steer a later outbound shell command in the same reply. */
const READS_UNTRUSTED: ReadonlySet<string> = new Set([
  WEB_FETCH_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  'skill',
  'session_read',
  'screen_capture',
  'simulator_screenshot',
  'model_view',
  'model_screenshot',
  'model_record',
]);

export function readsUntrusted(toolName: string): boolean {
  return READS_UNTRUSTED.has(toolName) || toolName.startsWith('browser_') || toolName.startsWith(MCP_TOOL_PREFIX);
}

/** These calls can move data or instructions beyond the reply whose provenance was checked. */
const OUTBOUND_TOOLS: ReadonlySet<string> = new Set([
  WEB_FETCH_TOOL_NAME,
  'browser_navigate',
  'browser_tabs',
  'session_send',
  'session_spawn',
  'simulator_open_url',
]);

export function sendsOut(toolName: string, input: Readonly<Record<string, unknown>> = {}): boolean {
  // These actions only select or remove existing local tab handles. Opening a URL and future
  // unknown actions stay classified as outbound; signed-in reads retain their separate gate.
  if (toolName === 'browser_tabs' && (input.action === 'list' || input.action === 'close' || input.action === 'select'))
    return false;
  return OUTBOUND_TOOLS.has(toolName) || toolName.startsWith(MCP_TOOL_PREFIX);
}
