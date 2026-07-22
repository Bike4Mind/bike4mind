/**
 * Escapes &, <, >, " - safe for BOTH attribute values and element inner text.
 * The single shared copy: shareFooter, markdown export, and the embed snippet
 * builders all interpolate user-influenced strings into HTML the same way.
 */
export function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
