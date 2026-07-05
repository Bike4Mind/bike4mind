import { IconButton, useTheme } from '@mui/joy';
import { ButtonProps } from '@mui/joy/Button';
import { useColorScheme } from '@mui/joy/styles';
import { useEffect, useState } from 'react';
import DarkModeIcon from '@mui/icons-material/DarkMode';
import LightModeIcon from '@mui/icons-material/LightMode';
import Tooltip from '@mui/joy/Tooltip';
import { useTranslation } from 'react-i18next';

type ModeToggleProps = {
  lightLabel?: string;
  darkLabel?: string;
  variant?: ButtonProps['variant'];
};

const ModeToggle: React.FC<ModeToggleProps> = ({ lightLabel, darkLabel, variant = 'outlined' }) => {
  const [mounted, setMounted] = useState(false);
  const { t } = useTranslation();

  const { setMode } = useColorScheme();
  const theme = useTheme();
  const mode = theme.palette.mode;

  darkLabel = darkLabel || t('theme.turn-dark');
  lightLabel = lightLabel || t('theme.turn-light');

  // necessary for server-side rendering
  // because mode is undefined on the server
  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return null;
  }

  return (
    <>
      <Tooltip title={mode === 'dark' ? lightLabel : darkLabel} className="mode-toggle-tooltip">
        <IconButton
          className="mode-toggle-button"
          variant={'outlined'}
          color={'neutral'}
          sx={{ width: '36px', height: '36px' }}
          onClick={() => {
            setMode(mode === 'dark' ? 'light' : 'dark');
          }}
          title={mode === 'dark' ? lightLabel : darkLabel}
        >
          {mode === 'dark' ? (
            <LightModeIcon className="mode-toggle-light-icon" sx={{ fontSize: '18px' }} color="warning" />
          ) : (
            <DarkModeIcon className="mode-toggle-dark-icon" sx={{ fontSize: '18px' }} color="primary" />
          )}
        </IconButton>
      </Tooltip>
    </>
  );
};

export default ModeToggle;
