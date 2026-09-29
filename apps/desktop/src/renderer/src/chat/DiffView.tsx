import { memo, type ReactNode } from 'react';
import Box from '@mui/joy/Box';
import Sheet from '@mui/joy/Sheet';
import { useTheme } from '@mui/joy/styles';
import Typography from '@mui/joy/Typography';
import { createElement, Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import type { ChatDiff, ChatDiffLine, ChatDiffLineKind } from '@shared/chat';
import { diffLanguage } from './diffLanguage';
import { SYNTAX_THEMES } from './markdown/syntaxTheme';

/**
 * Joy tokens, not raw green and red: the diff has to stay legible in both themes, and it sits
 * inside an approval card that is already `color="primary"`.
 *
 * Only the background is set on a changed line. The text itself is coloured by the syntax
 * theme - tinting it as well would flatten every token in the hunk to one colour, which is the
 * half of the change the reader is actually trying to read.
 *
 * A thin wash off the palette channel rather than `softBg`: that token is opaque and, in dark
 * mode, dark enough that a comment token sits on it at barely any contrast at all. At this
 * alpha the row still reads green or red at a glance and every token keeps its own colour.
 */
const CHANGED_LINE_ALPHA = 0.16;

const LINE_STYLE: Record<ChatDiffLineKind, { bgcolor?: string; marker: string; markerColor: string }> = {
  add: {
    bgcolor: `rgba(var(--joy-palette-success-mainChannel) / ${CHANGED_LINE_ALPHA})`,
    marker: '+',
    markerColor: 'success.plainColor',
  },
  remove: {
    bgcolor: `rgba(var(--joy-palette-danger-mainChannel) / ${CHANGED_LINE_ALPHA})`,
    marker: '-',
    markerColor: 'danger.plainColor',
  },
  context: { marker: ' ', markerColor: 'text.tertiary' },
  gap: { marker: ' ', markerColor: 'text.tertiary' },
};

const GUTTER_WIDTH = 34;

function LineNumber({ value }: { value?: number }) {
  return (
    <Box
      component="span"
      sx={{
        width: GUTTER_WIDTH,
        flex: '0 0 auto',
        textAlign: 'right',
        pr: 0.75,
        color: 'text.tertiary',
        userSelect: 'none',
      }}
    >
      {value ?? ''}
    </Box>
  );
}

function DiffRow({ line, children }: { line: ChatDiffLine; children: ReactNode }) {
  const style = LINE_STYLE[line.kind];
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'flex-start',
        bgcolor: style.bgcolor,
        fontFamily: 'monospace',
        fontSize: 'xs',
        lineHeight: 'sm',
      }}
      data-testid="chat-tool-diff-line"
      data-kind={line.kind}
    >
      <LineNumber value={line.oldLine} />
      <LineNumber value={line.newLine} />
      <Box
        component="span"
        sx={{ width: 14, flex: '0 0 auto', textAlign: 'center', color: style.markerColor, userSelect: 'none' }}
      >
        {style.marker}
      </Box>
      <Box
        component="span"
        sx={{ flex: 1, minWidth: 0, pr: 1, color: 'text.secondary', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
      >
        {children}
      </Box>
    </Box>
  );
}

function GapRow({ line }: { line: ChatDiffLine }) {
  return (
    <Typography
      level="body-xs"
      fontFamily="monospace"
      textColor="text.tertiary"
      sx={{ px: 1, py: 0.25, textAlign: 'center' }}
      data-testid="chat-tool-diff-line"
      data-kind="gap"
    >
      &#8943; {line.text} &#8943;
    </Typography>
  );
}

/**
 * The hunk, tokenized once and handed back a row at a time.
 *
 * One highlighter over the whole body rather than one per line: the tokenizer is the expensive
 * part, and a four-hundred-line diff would pay for it four hundred times. `renderer` is the
 * hook that exists for this - it hands back one node per input line, which is exactly the
 * granularity the gutter and the +/- tint need.
 *
 * What it tokenizes is a hunk, not a file: a removed line sits directly above the line that
 * replaced it, and an unterminated string or comment on one of them can bleed into the rows
 * below. Every diff viewer that highlights hunks has this, and the alternative - no colour at
 * all - costs more on every diff than the bleed costs on a few.
 */
const HighlightedLines = memo(function HighlightedLines({ diff, mode }: { diff: ChatDiff; mode: 'light' | 'dark' }) {
  // Gaps are not source, so they contribute a blank line: dropping them instead would shift
  // every row after the first gap onto the wrong diff line.
  const source = diff.lines.map(line => (line.kind === 'gap' ? '' : line.text)).join('\n');

  return (
    <SyntaxHighlighter
      language={diffLanguage(diff.path)}
      style={SYNTAX_THEMES[mode]}
      PreTag="div"
      CodeTag="div"
      renderer={({ rows, stylesheet, useInlineStyles }) => (
        <>
          {diff.lines.map((line, index) => {
            if (line.kind === 'gap') return <GapRow key={index} line={line} />;
            const row = rows[index];
            return (
              <DiffRow key={index} line={line}>
                {/* A row the tokenizer did not produce - a trailing blank it trimmed - falls
                    back to the text itself, so no line can silently vanish from the diff. */}
                {row ? createElement({ node: row, stylesheet, useInlineStyles, key: String(index) }) : line.text || ' '}
              </DiffRow>
            );
          })}
        </>
      )}
    >
      {source}
    </SyntaxHighlighter>
  );
});

/**
 * A change to one file, line by line.
 *
 * Used for both halves of ChatDiff's contract, and it deliberately says nothing about which:
 * the approval card renders a proposal above its buttons, the transcript renders a record of
 * what landed, and the words that tell those apart belong to the card and the row, not here.
 */
export function DiffView({ diff }: { diff: ChatDiff }) {
  const mode = useTheme().palette.mode === 'dark' ? 'dark' : 'light';

  return (
    <Sheet
      variant="outlined"
      sx={{ borderRadius: 'sm', overflow: 'hidden', bgcolor: 'background.surface' }}
      data-testid="chat-tool-diff"
    >
      <Box
        sx={{
          px: 1,
          py: 0.5,
          borderBottom: '1px solid',
          borderColor: 'divider',
          display: 'flex',
          gap: 1,
          alignItems: 'baseline',
        }}
      >
        <Typography level="body-xs" fontFamily="monospace" noWrap sx={{ minWidth: 0, flex: 1 }}>
          {diff.path}
        </Typography>
        <Typography level="body-xs" textColor="success.plainColor">
          +{diff.added}
        </Typography>
        <Typography level="body-xs" textColor="danger.plainColor">
          -{diff.removed}
        </Typography>
      </Box>

      <Box sx={{ maxHeight: 320, overflow: 'auto', py: 0.25 }}>
        {diff.lines.length > 0 && <HighlightedLines diff={diff} mode={mode} />}
      </Box>

      {diff.truncated && (
        <Typography level="body-xs" textColor="text.tertiary" sx={{ px: 1, py: 0.5 }}>
          Too large to show line by line; the change is shown as a whole-block replacement.
        </Typography>
      )}
    </Sheet>
  );
}
