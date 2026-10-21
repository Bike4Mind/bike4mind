import { LYRIC_LINE_TIMING_SOURCE } from '@bike4mind/common';

/** Display formatting for generated media, shared by the Studio and chat job cards and the Files details panel. */

/** `m:ss` from a length in seconds. */
export const formatSecondsClock = (totalSeconds: number): string => {
  const rounded = Math.round(totalSeconds);
  const minutes = Math.floor(rounded / 60);
  const seconds = rounded % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
};

// Guards songs stored before the provider stripped filled-in timings (normalizeLyriaLyrics).
const STAMP_ONLY_LINE = new RegExp(String.raw`^[ \t]*${LYRIC_LINE_TIMING_SOURCE}[ \t]*(?:\r?\n|$)`, 'gm');
const LEADING_STAMP = new RegExp(String.raw`^([ \t]*)${LYRIC_LINE_TIMING_SOURCE}[ \t]*`, 'gm');

/**
 * Lyrics for display: drops leading provider timestamps, and lines that hold nothing else (a blank line would read
 * as a section break), and keeps section tags such as `[Verse]`.
 */
export const stripLyricTimestamps = (lyrics: string): string =>
  lyrics.replace(STAMP_ONLY_LINE, '').replace(LEADING_STAMP, '$1');
