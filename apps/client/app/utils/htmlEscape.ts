/**
 * Escapes &, <, >, " - safe for BOTH attribute values and element inner text.
 * The single shared copy: shareFooter, markdown export, and the embed snippet
 * builders all interpolate user-influenced strings into HTML the same way.
 */
export function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Like escapeAttr but also escapes ' as &#39; - the stricter form used when rendering source
// into a code view or interpolating into single-quoted attributes. Re-exported from here so
// the app-layer call sites keep their import; the implementation is shared monorepo-wide.
export { escapeHtml } from '@bike4mind/utils/escapeHtml';
