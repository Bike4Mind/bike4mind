import Box from '@mui/joy/Box';
import type { SceneDefinition } from './sceneDefinition';

const PARCHMENT = 'rgba(255, 250, 240, 0.96)';
const INK = '#2a1d10';
const WOOD = '#6b4523';
const WOOD_DARK = '#4a2e14';

/** A border of whole pixels with notched corners, the pixel-art way, plus a hard drop shadow; no radius. */
const pixelFrame = (width: number) =>
  [
    `0 -${width}px 0 0 ${INK}`,
    `0 ${width}px 0 0 ${INK}`,
    `-${width}px 0 0 0 ${INK}`,
    `${width}px 0 0 0 ${INK}`,
    `${width * 2}px ${width * 3}px 0 0 rgba(0, 0, 0, 0.3)`,
  ].join(', ');

const SEND_TEXT = '#fbe9c8';
const inkTint = (alpha: number) => `rgba(42, 29, 16, ${alpha})`;

/**
 * Joy reads every variant colour through a `--variant-*` var before the theme's palette, so setting
 * them on parchment gives its controls ink-on-parchment rest, hover, press and disabled states in both
 * colour schemes. The focus ring is the theme's `palette-focusVisible`, retinted to wood the same way.
 */
export const PARCHMENT_CONTROLS = {
  '--joy-palette-focusVisible': WOOD,
  '--focus-outline-offset': '2px',
  '--Icon-color': INK,
  '--variant-plainColor': INK,
  '--variant-plainHoverColor': INK,
  '--variant-plainHoverBg': inkTint(0.08),
  '--variant-plainActiveBg': inkTint(0.16),
  '--variant-plainDisabledColor': inkTint(0.4),
  '--variant-outlinedColor': INK,
  '--variant-outlinedBorder': inkTint(0.4),
  '--variant-outlinedHoverColor': INK,
  '--variant-outlinedHoverBorder': inkTint(0.65),
  '--variant-outlinedHoverBg': inkTint(0.08),
  '--variant-outlinedActiveBg': inkTint(0.16),
  '--variant-outlinedDisabledColor': inkTint(0.4),
  '--variant-outlinedDisabledBorder': inkTint(0.2),
  '--variant-solidColor': SEND_TEXT,
  '--variant-solidBg': WOOD,
  '--variant-solidHoverBg': WOOD_DARK,
  '--variant-solidActiveBg': '#3a230f',
  '--variant-solidDisabledColor': inkTint(0.45),
  '--variant-solidDisabledBg': inkTint(0.12),
} as const;

/**
 * The host's latest reply as a speech bubble beside it, for while the conversation is out of sight:
 * its opening line or two, and the way to the whole reply.
 */
export function ReplyBubble({
  testId,
  anchor,
  board,
  snippet,
  onReadAll,
  onDismiss,
}: {
  /** Prefixes the test ids: `<testId>-reply-bubble`, `-reply-text`, `-reply-read-btn`, `-reply-dismiss-btn`. */
  testId: string;
  anchor: SceneDefinition['map']['reply'];
  /** Kept clear of on a narrow scene. */
  board: SceneDefinition['map']['board'];
  snippet: string;
  onReadAll(): void;
  onDismiss(): void;
}) {
  const action = {
    p: 0,
    border: 0,
    bgcolor: 'transparent',
    color: INK,
    font: 'inherit',
    cursor: 'pointer',
    textUnderlineOffset: '2px',
    '&:hover': { color: WOOD, textDecoration: 'underline' },
    '&:active': { color: WOOD_DARK },
    '&:focus-visible': { outline: `2px solid ${WOOD}`, outlineOffset: 2 },
  } as const;
  // Ends just beside the host, its tail pointing at it. On a narrow scene the 180px floor would reach
  // over the quest board; shrink instead.
  const side =
    'right' in anchor
      ? {
          right: `${anchor.right}%`,
          maxWidth: `calc(${100 - anchor.right}% - ${board.left + board.width}%)`,
          tail: { right: -11, borderWidth: '7px 0 7px 9px', borderColor: `transparent transparent transparent ${INK}` },
        }
      : {
          left: `${anchor.left}%`,
          maxWidth: `calc(${board.left > anchor.left ? board.left : 100}% - ${anchor.left}%)`,
          tail: { left: -11, borderWidth: '7px 9px 7px 0', borderColor: `transparent ${INK} transparent transparent` },
        };
  const { tail, ...edge } = side;
  return (
    <Box
      data-testid={`${testId}-reply-bubble`}
      role="status"
      sx={{
        position: 'absolute',
        top: `${anchor.top}%`,
        ...edge,
        zIndex: 250,
        width: 'clamp(180px, 34%, 320px)',
        px: '0.75em',
        py: '0.5em',
        boxShadow: pixelFrame(2),
        bgcolor: PARCHMENT,
        color: INK,
        fontSize: 'clamp(11px, 2.4cqh, 14px)',
        lineHeight: 1.35,
        '&::after': {
          content: '""',
          position: 'absolute',
          top: '60%',
          borderStyle: 'solid',
          ...tail,
        },
      }}
    >
      <Box
        data-testid={`${testId}-reply-text`}
        sx={{ display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
      >
        {snippet}
      </Box>
      <Box sx={{ display: 'flex', gap: '1em', mt: '0.35em', fontWeight: 700 }}>
        <Box component="button" type="button" onClick={onReadAll} sx={action} data-testid={`${testId}-reply-read-btn`}>
          Read all
        </Box>
        <Box
          component="button"
          type="button"
          onClick={onDismiss}
          sx={{ ...action, ml: 'auto', fontWeight: 500 }}
          data-testid={`${testId}-reply-dismiss-btn`}
        >
          Dismiss
        </Box>
      </Box>
    </Box>
  );
}
