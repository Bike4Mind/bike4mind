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
 *   fired under the `'auto'` Smart Routing default, replacing the user's Smart
 *   Tools selection with the agent's fixed toolset.
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

// User-facing explanation keyed by which auto-route fired. The `complexity`
// line additionally calls out that the rule-based reroute replaced the user's
// Smart Tools selection with the agent's fixed toolset.
const MESSAGE_BY_SOURCE: Record<AutoRouteSource, string> = {
  classifier: 'Agent mode auto-engaged - multi-step research detected.',
  complexity:
    'Agent mode auto-engaged - complex prompt detected. Your Smart Tools selection was replaced by the agent toolset.',
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
        spacing={1}
        sx={{
          px: 1.25,
          py: 0.75,
          borderRadius: 'md',
          bgcolor: 'background.level1',
          border: '1px solid',
          borderColor: 'primary.outlinedBorder',
        }}
      >
        <AutoAwesomeIcon sx={{ fontSize: 16, color: 'primary.plainColor' }} />
        <Typography level="body-sm" sx={{ flex: 1 }}>
          {MESSAGE_BY_SOURCE[source]}
        </Typography>
        <Button
          data-testid="auto-route-badge-dismiss"
          size="sm"
          variant="plain"
          color="neutral"
          onClick={() => setLLM({ disableAutoRouteForThisSession: true })}
        >
          Dismiss
        </Button>
      </Stack>
    </Box>
  );
};

export default AutoRouteBadge;
