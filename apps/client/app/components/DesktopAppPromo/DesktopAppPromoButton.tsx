import { Box, IconButton } from '@mui/joy';
import { useMediaQuery } from '@mui/system';
import { useTranslation } from 'react-i18next';
import CloseIcon from '@mui/icons-material/Close';
import DesktopMacOutlinedIcon from '@mui/icons-material/DesktopMacOutlined';
import { useUserSettings } from '@client/app/contexts/UserSettingsContext';
import { useDesktopPromoEnabled } from '@client/app/hooks/useDesktopPromoEnabled';
import { openInNewTab } from '@client/app/utils/externalLinks';

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
  const { t } = useTranslation();

  // isHydrated: the preference defaults to false until the user record lands.
  if (!enabled || !isHydrated || settings.desktopPromoDismissed || !wideScreenWithMouse) return null;

  const openDesktopPage = () => openInNewTab('/desktop');

  // Glass pill copied from the marketing site's announcement bar (fixed primary tint, not the theme
  // channel, so both color schemes match it). The whole pill is the link, so the dismiss button
  // below stops its click from bubbling up to it.
  return (
    <Box
      data-testid="desktop-promo"
      role="button"
      tabIndex={0}
      onClick={openDesktopPage}
      onKeyDown={e => {
        // A keydown on the nested dismiss button bubbles here; leave it to become that button's click.
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openDesktopPage();
        }
      }}
      sx={theme => ({
        display: 'flex',
        alignItems: 'center',
        py: 0.5,
        pl: 2,
        pr: 0.5,
        minHeight: 40,
        borderRadius: '12px',
        border: '1px solid rgba(11, 107, 203, 0.6)',
        bgcolor: 'rgba(11, 107, 203, 0.16)',
        backdropFilter: 'blur(16px)',
        color: 'text.primary',
        [theme.getColorSchemeSelector('dark')]: { color: 'common.white' },
        fontSize: 'sm',
        fontWeight: 'lg',
        cursor: 'pointer',
        transition: 'background-color 0.2s ease, border-color 0.2s ease',
        userSelect: 'none',
        '&:hover': { bgcolor: 'rgba(11, 107, 203, 0.24)' },
        '&:focus-visible': { outline: '2px solid', outlineColor: 'focusVisible', outlineOffset: 2 },
      })}
    >
      <DesktopMacOutlinedIcon sx={{ fontSize: 14, color: 'inherit', mr: 1 }} />
      <Box component="span" sx={{ flexGrow: 1, minWidth: 0 }}>
        {t('desktopApp.tryTheApp', 'Try the desktop app')}
      </Box>
      <IconButton
        data-testid="desktop-promo-dismiss-btn"
        variant="plain"
        color="neutral"
        size="sm"
        aria-label={t('desktopApp.dismissSuggestion', 'Dismiss desktop app suggestion')}
        onClick={e => {
          e.stopPropagation();
          updatePreferences({ desktopPromoDismissed: true });
        }}
        sx={theme => ({
          ml: 0.5,
          minWidth: 30,
          minHeight: 30,
          p: '0 2px',
          borderRadius: '8px',
          color: 'text.tertiary',
          '--Icon-color': 'currentColor',
          transition: 'color 0.2s ease, background-color 0.2s ease',
          '&:hover': { color: 'text.primary', bgcolor: 'rgba(0, 0, 0, 0.06)' },
          [theme.getColorSchemeSelector('dark')]: {
            color: 'rgba(255, 255, 255, 0.6)',
            '&:hover': { color: 'common.white', bgcolor: 'rgba(255, 255, 255, 0.1)' },
          },
        })}
      >
        <CloseIcon sx={{ fontSize: 16 }} />
      </IconButton>
    </Box>
  );
}
