import { useState } from 'react';
import { Box, IconButton, Link, Tooltip, Typography } from '@mui/joy';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import { openHelpPanel } from '@client/app/hooks/useHelpPanel';

interface DestructiveActionHelpProps {
  /** Plain-language explanation of what the destructive action does - revealed on hover. */
  consequences: string;
  /** Optional help article slug; when set, a "Learn more" link opens the Help Center to it. */
  helpId?: string;
  /** Leading affordance label; defaults to "Here's what happens". */
  label?: string;
  'data-testid'?: string;
}

/**
 * Predictive, non-intrusive help for destructive actions.
 *
 * Renders a subtle inline "Here's what happens" affordance next to a destructive control. Hovering
 * reveals the consequences in a tooltip (never a blocking popup/modal), with an optional deep link
 * to the relevant help article. Dismissible - the dismissed state is local to the mounted instance
 * and resets if the control re-mounts (intentional: re-surface the hint for each user/context).
 */
export default function DestructiveActionHelp({
  consequences,
  helpId,
  label = "Here's what happens",
  'data-testid': dataTestId = 'destructive-action-help',
}: DestructiveActionHelpProps) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;

  return (
    <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }} data-testid={dataTestId}>
      <Tooltip
        variant="soft"
        placement="top"
        enterDelay={0}
        title={
          <Box sx={{ maxWidth: 260 }}>
            <Typography level="body-sm" data-testid={`${dataTestId}-consequences`}>
              {consequences}
            </Typography>
            {helpId && (
              <Link
                component="button"
                level="body-xs"
                data-testid={`${dataTestId}-link`}
                onClick={() => openHelpPanel(helpId)}
              >
                Learn more
              </Link>
            )}
          </Box>
        }
      >
        <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.25, cursor: 'help' }}>
          <InfoOutlinedIcon color="warning" sx={{ fontSize: 16 }} />
          <Typography level="body-xs" data-testid={`${dataTestId}-label`}>
            {label}
          </Typography>
        </Box>
      </Tooltip>
      <IconButton
        variant="plain"
        color="neutral"
        size="sm"
        aria-label="Dismiss help hint"
        data-testid={`${dataTestId}-dismiss-btn`}
        onClick={() => setDismissed(true)}
        sx={{ '--IconButton-size': '20px' }}
      >
        <CloseRoundedIcon sx={{ fontSize: 14 }} />
      </IconButton>
    </Box>
  );
}
