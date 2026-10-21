/**
 * Protocols a link out of the renderer may be handed to the OS with.
 *
 * Deliberately short. `file:` would open a local path, `javascript:` is a script, and on
 * Windows the platform handler reaches further than either - and every one of these urls
 * arrives from model output, through a link in a reply or through a navigation the renderer
 * did not mean to make.
 */
const OPENABLE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

/**
 * Whether a url may be handed to shell.openExternal.
 *
 * The gate lives in main rather than in the renderer because main is the side with the
 * privilege: the renderer's sanitizer covers links that went through the markdown pipeline,
 * and this covers everything, including a navigation that never was a link.
 */
export function isExternallyOpenable(url: string): boolean {
  try {
    return OPENABLE_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    // Not a url at all, so there is nothing to open.
    return false;
  }
}
