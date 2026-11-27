import { Fragment, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import Box from '@mui/joy/Box';
import type { SkillMention } from '@shared/skills';
import type { CodeRange } from './composerMarkdown';

export type HighlightColor = 'primary' | 'warning' | 'neutral';

export interface HighlightToken extends SkillMention {
  color: HighlightColor;
}

/** What the mirror copies off the textarea so its glyphs land exactly where the real ones do. */
const MIRRORED_STYLES = [
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'lineHeight',
  'letterSpacing',
  'wordSpacing',
  'textIndent',
  'textTransform',
  'tabSize',
] as const;

type Part = { text: string; token?: HighlightToken; code?: CodeRange['kind'] };

/**
 * The draft cut into plain runs, token pills and code ranges. Code wins where a token overlaps
 * it, since two marks over one glyph would paint twice. A block takes the newline after it:
 * it renders as a display:block element, and a block's own trailing newline adds no line, so
 * the text after it starts on the next line exactly as it does in the textarea.
 */
function splitParts(text: string, tokens: readonly HighlightToken[], code: readonly CodeRange[]): Part[] {
  const marks: { start: number; end: number; token?: HighlightToken; code?: CodeRange['kind'] }[] = [
    ...code.map(range => {
      const end = range.kind === 'block' && text[range.end] === '\n' ? range.end + 1 : range.end;
      return { start: range.start, end, code: range.kind };
    }),
    ...tokens
      .filter(token => !code.some(range => token.start < range.end && range.start < token.end))
      .map(token => ({ start: token.start, end: token.end, token })),
  ].sort((a, b) => a.start - b.start);

  const parts: Part[] = [];
  let cursor = 0;
  for (const mark of marks) {
    if (mark.start < cursor) continue;
    if (mark.start > cursor) parts.push({ text: text.slice(cursor, mark.start) });
    parts.push({ text: text.slice(mark.start, mark.end), token: mark.token, code: mark.code });
    cursor = mark.end;
  }
  parts.push({ text: text.slice(cursor) });
  return parts;
}

/**
 * A soft pill behind each skill token in the composer.
 *
 * A textarea cannot style part of its own text, so this is a MIRROR: a div laid exactly over the
 * textarea's box, holding the same text in transparent ink, with the tokens wrapped in marks. It
 * sits BEHIND the textarea (which is transparent-backgrounded), so the real text, caret,
 * selection and IME are all the browser's own and untouched. That is also why it only paints a
 * background rather than recolouring the glyphs: if the two ever drift by a pixel, a pill sits a
 * pixel off instead of the draft rendering twice.
 *
 * Render it as the Textarea's startDecorator with the decorator slot absolutely positioned; see
 * Composer for the slot wiring that keeps it out of the flex row and under the text.
 */
export function ComposerHighlight({
  text,
  tokens,
  code = [],
  textareaRef,
}: {
  text: string;
  tokens: readonly HighlightToken[];
  /** Code spans and fenced blocks, painted with the same soft background code has in replies. */
  code?: readonly CodeRange[];
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const mirrorRef = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState<CSSProperties | null>(null);

  // Measured rather than hard-coded, so a change to Joy's paddings or the composer's font size
  // cannot silently misplace the pills. Re-run on every draft change: autosize moves the height.
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const measure = () => {
      const computed = getComputedStyle(textarea);
      const next: CSSProperties = {
        top: textarea.offsetTop + textarea.clientTop,
        left: textarea.offsetLeft + textarea.clientLeft,
        // client* excludes the scrollbar, so the mirror wraps at the same column the text does.
        width: textarea.clientWidth,
        height: textarea.clientHeight,
      };
      for (const property of MIRRORED_STYLES) Object.assign(next, { [property]: computed[property] });
      setBox(next);
      if (mirrorRef.current) mirrorRef.current.scrollTop = textarea.scrollTop;
    };
    measure();
    const onScroll = () => {
      if (mirrorRef.current) mirrorRef.current.scrollTop = textarea.scrollTop;
    };
    textarea.addEventListener('scroll', onScroll);
    // Absent in jsdom; the draft-change rerun above still covers the common path there.
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(textarea);
    return () => {
      textarea.removeEventListener('scroll', onScroll);
      observer?.disconnect();
    };
  }, [text, textareaRef]);

  const parts = splitParts(text, tokens, code);

  return (
    <Box
      ref={mirrorRef}
      aria-hidden
      data-testid="composer-skill-highlight"
      sx={{
        position: 'absolute',
        boxSizing: 'border-box',
        overflow: 'hidden',
        // The textarea's own wrapping rules, so lines break at the same characters.
        whiteSpace: 'pre-wrap',
        overflowWrap: 'break-word',
        color: 'transparent',
        pointerEvents: 'none',
        visibility: box ? 'visible' : 'hidden',
      }}
      style={box ?? undefined}
    >
      {parts.map((part, index) =>
        part.code ? (
          <Box
            key={index}
            component="mark"
            data-code-kind={part.code}
            sx={theme => {
              const palette = theme.vars.palette.neutral;
              return part.code === 'block'
                ? // No padding or margin: either would move the glyphs out of line with the textarea's.
                  { display: 'block', color: 'transparent', bgcolor: palette.softBg, borderRadius: '6px' }
                : {
                    color: 'transparent',
                    bgcolor: palette.softBg,
                    borderRadius: '4px',
                    boxShadow: `0 0 0 2px ${palette.softBg}`,
                  };
            }}
          >
            {part.text}
          </Box>
        ) : part.token ? (
          <Box
            key={index}
            component="mark"
            data-skill-token={part.token.name}
            sx={theme => {
              const palette = theme.vars.palette[part.token?.color ?? 'primary'];
              return {
                color: 'transparent',
                bgcolor: palette.softBg,
                borderRadius: '4px',
                // A ring rather than padding: padding would widen the mark and push every
                // following glyph out of line with the textarea's.
                boxShadow: `0 0 0 2px ${palette.softBg}, inset 0 -1px 0 ${palette.outlinedBorder}`,
              };
            }}
          >
            {part.text}
          </Box>
        ) : (
          <Fragment key={index}>{part.text}</Fragment>
        )
      )}
      {/* A trailing newline only takes up a line when something follows it. */}
      {'\u200b'}
    </Box>
  );
}
