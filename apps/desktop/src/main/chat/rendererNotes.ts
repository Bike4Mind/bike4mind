/** The most notes one renderer-sent turn may carry, and the longest each may be (characters). */
export const MAX_RENDERER_NOTES = 4;
export const MAX_RENDERER_NOTE_LENGTH = 8000;

/**
 * Narrows the notes a send request carries off IPC. They become a system-reminder on the turn,
 * so anything that is not a short list of non-empty strings is dropped rather than trusted.
 */
export function rendererNotes(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const notes = raw
    .filter((note): note is string => typeof note === 'string' && note.trim().length > 0)
    .slice(0, MAX_RENDERER_NOTES)
    .map(note => note.slice(0, MAX_RENDERER_NOTE_LENGTH));
  return notes.length > 0 ? notes : undefined;
}
