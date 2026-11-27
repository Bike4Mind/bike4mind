import Box from '@mui/joy/Box';
import { stateLampColor } from '../statePalette';
import { ASK_STATE_LABEL, type AskState, type SceneAsk } from './sceneAsk';

/** What the bubble over a waiting agent says: its heading ("Needs you!"), the ask, and where it stands. */
export interface SpriteAsk {
  heading: string;
  state: AskState;
  ask: SceneAsk;
}

const INK = '#2a1d10';

// Fixed colours: the bubble sits on scene art, which is the same in either app theme.
const FILL: Record<AskState, string> = {
  waiting: stateLampColor('needs-you'),
  approved: '#cfe8c4',
  denied: '#f3c9c0',
  answered: 'rgba(255, 250, 240, 0.94)',
  elsewhere: 'rgba(255, 250, 240, 0.94)',
};

/**
 * The bubble over a waiting agent when the scene's dialogue box holds its request: the tool and target or
 * the question and its options, and the request's state. It answers nothing itself; a click reaches the
 * sprite, which brings the request to the front of the box with its own Approve and Deny.
 */
export function AskBubble({ testId, ask }: { testId: string; ask: SpriteAsk }) {
  const waiting = ask.state === 'waiting';
  return (
    <Box
      data-testid={testId}
      data-ask-state={ask.state}
      sx={{
        position: 'absolute',
        bottom: '88%',
        left: '50%',
        transform: 'translateX(-50%)',
        width: 'max-content',
        maxWidth: 'min(30cqw, 240px)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '0.2em',
        px: '0.6em',
        py: '0.3em',
        borderRadius: '6px',
        border: `2px solid ${INK}`,
        bgcolor: FILL[ask.state],
        color: INK,
        fontSize: 'clamp(9px, 2.1cqh, 13px)',
        lineHeight: 1.2,
        textAlign: 'center',
        pointerEvents: 'auto',
        cursor: 'pointer',
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: '0.4em', whiteSpace: 'nowrap' }}>
        <Box component="span" sx={{ fontWeight: 700, fontSize: waiting ? '1.2em' : undefined }}>
          {ask.heading}
        </Box>
        {waiting && (
          <Box
            component="span"
            data-testid={`${testId}-state`}
            sx={{ px: '0.35em', border: `1px solid ${INK}`, borderRadius: '3px', fontSize: '0.85em' }}
          >
            {ASK_STATE_LABEL.waiting}
          </Box>
        )}
      </Box>
      <Box data-testid={`${testId}-ask`} sx={{ fontWeight: 500, overflowWrap: 'anywhere' }}>
        {ask.ask.what}
      </Box>
      {ask.ask.options.length > 0 && (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: '0.25em' }}>
          {ask.ask.options.map((option, index) => (
            <Box
              key={`${index}-${option}`}
              component="span"
              data-testid={`${testId}-option-${index}`}
              sx={{
                px: '0.35em',
                border: `1px solid ${INK}`,
                borderRadius: '3px',
                bgcolor: 'rgba(255, 250, 240, 0.7)',
              }}
            >
              {option}
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}
