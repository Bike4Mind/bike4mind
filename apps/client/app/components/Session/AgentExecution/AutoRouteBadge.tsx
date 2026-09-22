import { FC } from 'react';
import { Box, Button, Chip, Stack, Typography } from '@mui/joy';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import { useLLM } from '@client/app/contexts/LLMContext';

/**
 * AutoRouteBadge - surfaced above the assistant message body when an auto-route
 * promoted a query to the agent executor without an explicit user toggle.
 *
 * Renders for two `routingSource` values:
 * - `classifier`: the M4 classifier upgraded a `'contextual'` query.
 * - `complexity`: the rule-based `complexity === 'complex'` fallback
 *   fired under the `'auto'` Smart Routing default.
 *
 * The "Dismiss" action flips `disableAutoRouteForThisSession`, suppressing both
 * auto-route paths for the remainder of the session - primary remediation for
 * false positives.
 *
 * Intentionally NOT placed in the message footer chip row: the badge needs
 * to be discoverable above the body so a user reading the response sees
 * *why* they're getting an agent-style answer before they finish the read.
 */
export type AutoRouteSource = 'classifier' | 'complexity';

// User-facing explanation keyed by which auto-route fired. Neither line claims
// anything about the Smart Tools selection: an agentless run now carries the
// user's picks unioned with the agent-mode defaults (see `resolveDispatchTools`),
// so the old "your selection was replaced" copy would be untrue.
const MESSAGE_BY_SOURCE: Record<AutoRouteSource, string> = {
  classifier: 'Agent mode auto-engaged - multi-step research detected.',
  complexity: 'Agent mode auto-engaged - complex prompt detected.',
};

export const AutoRouteBadge: FC<{ source?: AutoRouteSource }> = ({ source = 'classifier' }) => {
  const setLLM = useLLM(s => s.setLLM);
  const dismissed = useLLM(s => s.disableAutoRouteForThisSession);

  if (dismissed) {
    // Already opted out for this session - render a quieter resting state so
    // the badge doesn't disappear mid-reread, which would shift layout and
    // make older messages look retroactively re-routed.
    return (
      <Box data-testid="auto-route-badge-dismissed" sx={{ mb: 1 }}>
        <Chip
          size="sm"
          variant="soft"
          color="neutral"
          startDecorator={<AutoAwesomeIcon sx={{ fontSize: 14 }} />}
          sx={{ fontWeight: 400 }}
        >
          Agent mode auto-engaged (auto-routing paused for this session)
        </Chip>
      </Box>
    );
  }

  return (
    <Box data-testid="auto-route-badge" sx={{ mb: 1 }}>
      <Stack
        direction="row"
        alignItems="center"
        spacing={1.5}
        sx={theme => ({
          p: '16px',
          // The shared card frame. It filled with background.level1, a token this theme never
          // defines, and outlined itself in primary - the only blue-edged frame in a reply.
          borderRadius: '8px',
          backgroundColor: theme.palette.reading.cardBase,
          backgroundImage: `linear-gradient(180deg, ${theme.palette.reading.cardTintTop}, ${theme.palette.reading.cardTintBottom})`,
          border: '1px solid',
          borderColor: theme.palette.reading.cardLine,
        })}
      >
        <AutoAwesomeIcon sx={{ fontSize: '1.25rem', color: 'text.tertiary', flexShrink: 0 }} />
        <Typography level="body-sm" sx={{ flex: 1, color: 'text.primary' }}>
          {MESSAGE_BY_SOURCE[source]}
        </Typography>
        <Button
          data-testid="auto-route-badge-dismiss"
          size="sm"
          variant="plain"
          color="neutral"
          onClick={() => setLLM({ disableAutoRouteForThisSession: true })}
          // Text, not a button shape. Joy's plain variant still paints a hover background and
          // carries button padding, which put a second frame inside the badge's own. The
          // underline is the whole hover cue, as on the show more/less control.
          sx={{
            p: 0,
            minHeight: 0,
            fontWeight: 400,
            '--variant-plainHoverBg': 'transparent',
            '--variant-plainActiveBg': 'transparent',
            '&:hover': { textDecoration: 'underline' },
          }}
        >
          Dismiss
        </Button>
      </Stack>
    </Box>
  );
};

export default AutoRouteBadge;
