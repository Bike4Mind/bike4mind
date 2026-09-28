import Box from '@mui/joy/Box';
import Sheet from '@mui/joy/Sheet';
import Typography from '@mui/joy/Typography';
import type { ChatDiff, ChatDiffLineKind } from '@shared/chat';

/**
 * Joy tokens, not raw green and red: the diff has to stay legible in both themes, and it sits
 * inside an approval card that is already `color="primary"`.
 */
const LINE_STYLE: Record<ChatDiffLineKind, { bgcolor?: string; color: string; marker: string }> = {
  add: { bgcolor: 'success.softBg', color: 'success.plainColor', marker: '+' },
  remove: { bgcolor: 'danger.softBg', color: 'danger.plainColor', marker: '-' },
  context: { color: 'text.secondary', marker: ' ' },
  gap: { color: 'text.tertiary', marker: ' ' },
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

/**
 * The change a write tool proposes, shown while it is still a proposal.
 *
 * Nothing here reports a completed action: this renders above the approve/deny buttons, and
 * the file is untouched for as long as it is on screen.
 */
export function DiffView({ diff }: { diff: ChatDiff }) {
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
        {diff.lines.map((line, index) => {
          const style = LINE_STYLE[line.kind];
          if (line.kind === 'gap') {
            return (
              <Typography
                // Diff lines have no identity of their own, and the list never reorders.
                key={index}
                level="body-xs"
                fontFamily="monospace"
                textColor={style.color}
                sx={{ px: 1, py: 0.25, textAlign: 'center' }}
              >
                ⋯ {line.text} ⋯
              </Typography>
            );
          }

          return (
            <Box
              key={index}
              sx={{
                display: 'flex',
                alignItems: 'flex-start',
                bgcolor: style.bgcolor,
                fontFamily: 'monospace',
                fontSize: 'xs',
                lineHeight: 'sm',
              }}
            >
              <LineNumber value={line.oldLine} />
              <LineNumber value={line.newLine} />
              <Box
                component="span"
                sx={{ width: 14, flex: '0 0 auto', textAlign: 'center', color: style.color, userSelect: 'none' }}
              >
                {style.marker}
              </Box>
              <Box
                component="span"
                sx={{
                  flex: 1,
                  minWidth: 0,
                  pr: 1,
                  color: style.color,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {line.text || ' '}
              </Box>
            </Box>
          );
        })}
      </Box>

      {diff.truncated && (
        <Typography level="body-xs" textColor="text.tertiary" sx={{ px: 1, py: 0.5 }}>
          This change is too large to show line by line; the whole file is being replaced.
        </Typography>
      )}
    </Sheet>
  );
}
