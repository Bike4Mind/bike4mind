/** Display formatting for generated media, shared by the Studio and chat job cards and the Files details panel. */

/** `m:ss` from a length in seconds. */
export const formatSecondsClock = (totalSeconds: number): string => {
  const rounded = Math.round(totalSeconds);
  const minutes = Math.floor(rounded / 60);
  const seconds = rounded % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
};

// Lyria returns each sung line prefixed with its `[start:end]` timing in seconds, e.g. `[3.4:6.9] windows down`.
const STAMP = String.raw`\[\d+(?:\.\d+)?:\d+(?:\.\d+)?\]`;
const STAMP_ONLY_LINE = new RegExp(String.raw`^[ \t]*${STAMP}[ \t]*(?:\r?\n|$)`, 'gm');
const LEADING_STAMP = new RegExp(String.raw`^([ \t]*)${STAMP}[ \t]*`, 'gm');

/**
 * Lyrics for display: drops leading provider timestamps, and lines that hold nothing else (a blank line would read
 * as a section break), and keeps section tags such as `[Verse]`.
 */
export const stripLyricTimestamps = (lyrics: string): string =>
  lyrics.replace(STAMP_ONLY_LINE, '').replace(LEADING_STAMP, '$1');
