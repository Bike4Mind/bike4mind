import Box from '@mui/joy/Box';
import Tooltip from '@mui/joy/Tooltip';

/** The four states the dot distinguishes, worst-first: the order they are resolved in. */
export type TurnState = 'streaming' | 'no-session' | 'not-ready' | 'ready';

const WORDS: Record<TurnState, string> = {
  streaming: 'Working',
  'no-session': 'No session',
  'not-ready': 'No folder',
  ready: 'Ready',
};

const COLORS: Record<TurnState, string> = {
  streaming: 'primary.solidBg',
  'no-session': 'neutral.softBg',
  'not-ready': 'warning.solidBg',
  ready: 'success.solidBg',
};

/**
 * Which state the dot is in. Resolved in this order on purpose: a window with no conversation
 * cannot have a turn running in it, and an unbound Code session cannot start one, so the two
 * blocked states outrank the busy one rather than racing it.
 */
export function turnState(input: { streaming: boolean; disabled: boolean; notReady: boolean }): TurnState {
  if (input.disabled) return 'no-session';
  if (input.notReady) return 'not-ready';
  return input.streaming ? 'streaming' : 'ready';
}

/**
 * Whether a reply is running, as one dot beside the signed-in account.
 *
 * It sits there rather than in the composer because it answers a question about the WINDOW, not
 * about the message being typed - and because the composer's own status line is now a ring
 * reporting a different quantity, where a second glyph next to it read as part of the same
 * reading. Beside the environment label it has the row to itself.
 *
 * The word it used to carry is now the tooltip and the accessible name rather than a label.
 * A bare coloured dot states nothing on its own, and this one still has to be readable by
 * someone who cannot see that it went blue.
 */
export function TurnDot({ state }: { state: TurnState }) {
  return (
    <Tooltip title={WORDS[state]} placement="top" variant="soft" size="sm">
      <Box
        role="status"
        aria-label={WORDS[state]}
        data-testid="turn-dot"
        data-state={state}
        sx={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0, bgcolor: COLORS[state] }}
      />
    </Tooltip>
  );
}
