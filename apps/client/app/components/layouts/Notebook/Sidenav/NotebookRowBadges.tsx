import { Box, Tooltip } from '@mui/joy';
import { useTranslation } from 'react-i18next';
import ImageIcon from '@mui/icons-material/Image';
import ApiIcon from '@mui/icons-material/Api';
import type { ISessionDocument } from '@bike4mind/common';

/** True when a session row has any badge to show, so callers can skip mounting the component. */
export function hasNotebookRowBadges(session: Pick<ISessionDocument, 'imageCount' | 'origin'>): boolean {
  return (session.imageCount ?? 0) > 0 || session.origin?.channel === 'api';
}

/**
 * Compact markers before a sidebar notebook name: an image icon when the notebook holds generated
 * images (ISession.imageCount) and an API icon when it was created through the API (ISession.origin).
 * Passed to SessionSidenavItem as its `leadingDecorator` by NotebookRow.
 */
export default function NotebookRowBadges({ session }: { session: Pick<ISessionDocument, 'imageCount' | 'origin'> }) {
  const { t } = useTranslation();
  const hasImages = (session.imageCount ?? 0) > 0;
  const isApi = session.origin?.channel === 'api';
  if (!hasImages && !isApi) return null;

  const iconSx = { fontSize: '14px', color: 'text.tertiary', display: 'block' };
  return (
    <Box
      data-testid="sidenav-row-badges"
      sx={{ display: 'inline-flex', alignItems: 'center', gap: '2px', mr: '4px', flexShrink: 0 }}
    >
      {isApi && (
        <Tooltip title={t('sidenav.badge.api', 'Created via the API')} placement="top" size="sm">
          <Box component="span" data-testid="sidenav-row-api-badge" sx={{ display: 'inline-flex' }}>
            <ApiIcon sx={iconSx} />
          </Box>
        </Tooltip>
      )}
      {hasImages && (
        <Tooltip title={t('sidenav.badge.images', 'Contains generated images')} placement="top" size="sm">
          <Box component="span" data-testid="sidenav-row-image-badge" sx={{ display: 'inline-flex' }}>
            <ImageIcon sx={iconSx} />
          </Box>
        </Tooltip>
      )}
    </Box>
  );
}
