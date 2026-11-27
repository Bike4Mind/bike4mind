import { Chip, Stack, Tooltip } from '@mui/joy';
import type { IExtendedFeedbackDocument } from './types';

interface ClientContextChipsProps {
  feedbackItem: Pick<IExtendedFeedbackDocument, 'clientContext'>;
}

/**
 * Where a report was written: surface, app version, page, window size and model. Renders nothing
 * for a report from before this was captured, so older rows look exactly as they did. The raw user
 * agent sits behind the platform chip's tooltip rather than taking a row of its own.
 */
const ClientContextChips = ({ feedbackItem }: ClientContextChipsProps) => {
  const context = feedbackItem.clientContext;
  if (!context) return null;

  const { platform, appVersion, path, viewport, model, userAgent } = context;
  const chips: Array<{ key: string; label: string; tooltip?: string }> = [];
  if (platform) chips.push({ key: 'platform', label: platform, tooltip: userAgent });
  if (appVersion) chips.push({ key: 'version', label: `v${appVersion}` });
  if (path) chips.push({ key: 'path', label: path, tooltip: 'Page the report was written on' });
  if (viewport) chips.push({ key: 'viewport', label: `${viewport.width}x${viewport.height}` });
  if (model) chips.push({ key: 'model', label: model, tooltip: 'Model in use' });
  // A context holding only the server-read user agent has no chip of its own; show it as one.
  if (chips.length === 0 && userAgent) chips.push({ key: 'ua', label: 'browser', tooltip: userAgent });
  if (chips.length === 0) return null;

  return (
    <Stack
      direction="row"
      spacing={0.5}
      alignItems="center"
      sx={{ mb: 0.5, flexWrap: 'wrap' }}
      useFlexGap
      data-testid="feedback-client-context"
    >
      {chips.map(({ key, label, tooltip }) => {
        const chip = (
          <Chip size="sm" variant="outlined" data-testid={`feedback-client-context-${key}`}>
            {label}
          </Chip>
        );
        return tooltip ? (
          <Tooltip key={key} title={tooltip}>
            {chip}
          </Tooltip>
        ) : (
          <span key={key}>{chip}</span>
        );
      })}
    </Stack>
  );
};

export default ClientContextChips;
