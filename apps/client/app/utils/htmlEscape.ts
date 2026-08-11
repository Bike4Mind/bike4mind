/**
 * Escapes &, <, >, " - safe for BOTH attribute values and element inner text.
 * The single shared copy: shareFooter, markdown export, and the embed snippet
 * builders all interpolate user-influenced strings into HTML the same way.
 */
export function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Like escapeAttr but also escapes ' (single quote) as &#39; - the stricter form used when
 * rendering source into a code view or interpolating into single-quoted attributes. Shared
 * by the server artifact renderer; keep byte-identical to any sibling copies it pins against.
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
