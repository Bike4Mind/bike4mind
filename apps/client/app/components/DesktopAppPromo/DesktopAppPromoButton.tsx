import { Box, Button, IconButton } from '@mui/joy';
import { useMediaQuery } from '@mui/system';
import { useNavigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import DesktopMacOutlinedIcon from '@mui/icons-material/DesktopMacOutlined';
import { useUserSettings } from '@client/app/contexts/UserSettingsContext';
import { useDesktopPromoEnabled } from '@client/app/hooks/useDesktopPromoEnabled';

// There is no mobile or tablet build, so the promo only shows on a wide screen with a mouse.
export const DESKTOP_PROMO_MEDIA_QUERY = '(min-width: 900px) and (hover: hover) and (pointer: fine)';

/**
 * "Try the desktop app" pill for the signed-in shell, linking to /desktop. It sits in the sidebar
 * footer above the profile card: every corner of the content area is taken by the composer, toasts,
 * the data-lake upload indicator or a notebook's header actions.
 * Gated by the `showDesktopAppPromo` admin setting; closing it sets the user's
 * `desktopPromoDismissed` preference, so it stays gone on every device.
 */
export default function DesktopAppPromoButton() {
  const enabled = useDesktopPromoEnabled();
  const { settings, isHydrated, updatePreferences } = useUserSettings();
  const wideScreenWithMouse = useMediaQuery(DESKTOP_PROMO_MEDIA_QUERY);
  const navigate = useNavigate();
  const { t } = useTranslation();

  // isHydrated: the preference defaults to false until the user record lands.
  if (!enabled || !isHydrated || settings.desktopPromoDismissed || !wideScreenWithMouse) return null;

  return (
    <Box
      data-testid="desktop-promo"
      sx={{
        alignSelf: 'flex-start',
        display: 'flex',
        alignItems: 'center',
        borderRadius: '999px',
        border: '1px solid',
        borderColor: 'divider',
        bgcolor: 'background.surface',
        boxShadow: 'xs',
      }}
    >
      <Button
        data-testid="desktop-promo-open-btn"
        variant="plain"
        color="neutral"
        size="sm"
        startDecorator={<DesktopMacOutlinedIcon sx={{ fontSize: 18 }} />}
        onClick={() => navigate({ to: '/desktop' })}
        sx={{ borderRadius: '999px', pl: 1.5, pr: 0.75, fontWeight: 500 }}
      >
        {t('desktopApp.tryTheApp', 'Try the desktop app')}
      </Button>
      <IconButton
        data-testid="desktop-promo-dismiss-btn"
        variant="plain"
        color="neutral"
        size="sm"
        aria-label={t('desktopApp.dismissSuggestion', 'Dismiss desktop app suggestion')}
        onClick={() => updatePreferences({ desktopPromoDismissed: true })}
        sx={{ borderRadius: '999px', mr: 0.25, '--IconButton-size': '28px' }}
      >
        <CloseRoundedIcon sx={{ fontSize: 16 }} />
      </IconButton>
    </Box>
  );
}
