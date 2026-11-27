/**
 * Average advance of a bold sans-serif glyph, in em. ffmpeg's drawtext cannot wrap, so the worker wraps by
 * character count; erring wide keeps a line inside `maxWidthPct` rather than spilling past it.
 */
export const CAPTION_AVERAGE_GLYPH_WIDTH_EM = 0.6;

/** How many characters fit on one caption line of `availableWidthPx` at `fontSizePx`. At least one. */
export const estimateCaptionMaxLineChars = (availableWidthPx: number, fontSizePx: number): number =>
  Math.max(1, Math.floor(availableWidthPx / (fontSizePx * CAPTION_AVERAGE_GLYPH_WIDTH_EM)));

const wrapParagraph = (paragraph: string, maxChars: number): string[] => {
  const words = paragraph.split(/\s+/).filter(word => word.length > 0);
  if (words.length === 0) return [''];
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (current.length === 0) {
      current = word;
    } else if (current.length + 1 + word.length <= maxChars) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  lines.push(current);
  return lines;
};

/**
 * Greedy word wrap that honors explicit line breaks, like the preview's `white-space: pre-wrap`. A word longer than
 * a line stays whole on its own line (the browser lets it overflow too); a blank line is kept as ''.
 */
export const wrapStudioCaption = (text: string, maxChars: number): string[] =>
  text.split(/\r?\n/).flatMap(paragraph => wrapParagraph(paragraph, maxChars));
