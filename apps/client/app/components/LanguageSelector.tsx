import { SUPPORTED_LANGUAGES } from '@client/app/utils/i18n';
import LanguageIcon from '@mui/icons-material/Language';
import { Dropdown, Menu, MenuButton, MenuItem, Button, Box } from '@mui/joy';
import { useCallback, useMemo, useRef, useState, useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useLanguage } from '../contexts/TranslationProvider';

const LanguageSelector = () => {
  const [selectedLanguage, setSelectedLanguage] = useLanguage(useShallow(state => [state.language, state.setLanguage]));
  const [showTopScroll, setShowTopScroll] = useState(false);
  const [showBottomScroll, setShowBottomScroll] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const handleLanguageChange = useCallback(
    (lang: string) => () => {
      setSelectedLanguage(lang);
    },
    [setSelectedLanguage]
  );

  const currentLanguage = useMemo(
    () => SUPPORTED_LANGUAGES.find(lang => lang.code === selectedLanguage)?.name,
    [selectedLanguage]
  );

  // Sort the languages so that the selected language is always on top
  const menuItems = useMemo(
    () =>
      [...SUPPORTED_LANGUAGES]
        .sort(lang => (lang.code === selectedLanguage ? -1 : 1))
        .map(lang => (
          <MenuItem
            key={lang.code}
            onClick={handleLanguageChange(lang.code)}
            selected={selectedLanguage === lang.code}
            data-testid={`language-option-${lang.code}`}
          >
            {lang.name}
          </MenuItem>
        )),
    [selectedLanguage, handleLanguageChange]
  );

  // Handle scroll indicators
  const handleScroll = useCallback(() => {
    if (menuRef.current) {
      const { scrollTop, scrollHeight, clientHeight } = menuRef.current;
      setShowTopScroll(scrollTop > 0);
      setShowBottomScroll(scrollTop < scrollHeight - clientHeight - 1);
    }
  }, []);

  useEffect(() => {
    const menu = menuRef.current;
    if (menu) {
      menu.addEventListener('scroll', handleScroll);
      // Check initial state
      handleScroll();
      return () => menu.removeEventListener('scroll', handleScroll);
    }
  }, [handleScroll]);

  return (
    <Dropdown>
      <MenuButton
        data-testid="language-selector-btn"
        slots={{ root: Button }}
        slotProps={{ root: { variant: 'outlined', color: 'neutral' } }}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          minWidth: '140px',
          justifyContent: 'flex-start',
          color: 'text.primary',
          '& .MuiButton-startDecorator': {
            color: 'text.primary',
            opacity: 0.5,
          },
        }}
      >
        <LanguageIcon sx={{ fontSize: '18px', color: 'text.primary', opacity: 0.5 }} />
        {currentLanguage || 'Select Language'}
      </MenuButton>

      <Menu
        sx={{
          maxHeight: '200px', // Reduced height to make scrolling more obvious
          minWidth: '140px', // Match the button width
          zIndex: 1400,
          overflow: 'hidden', // Hide default scrollbar
          position: 'relative',
        }}
      >
        {/* Top scroll indicator */}
        {showTopScroll && (
          <Box
            sx={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              height: '20px',
              background: 'linear-gradient(to bottom, rgba(0,0,0,0.1), transparent)',
              pointerEvents: 'none',
              zIndex: 1,
            }}
          />
        )}

        {/* Bottom scroll indicator */}
        {showBottomScroll && (
          <Box
            sx={{
              position: 'absolute',
              bottom: 0,
              left: 0,
              right: 0,
              height: '20px',
              background: 'linear-gradient(to top, rgba(0,0,0,0.1), transparent)',
              pointerEvents: 'none',
              zIndex: 1,
            }}
          />
        )}

        <Box
          ref={menuRef}
          sx={theme => ({
            maxHeight: '200px',
            overflowY: 'auto',
            scrollBehavior: 'smooth',
            '&::-webkit-scrollbar-thumb': {
              backgroundColor: theme.palette.background.scrollbar,
              border: `2px solid ${theme.palette.background.scrollbarTrack}`,
              borderRadius: '20px',
            },
            '&::-webkit-scrollbar': {
              width: '8px',
            },
            '&::-webkit-scrollbar-track': {
              backgroundColor: theme.palette.background.scrollbarTrack,
            },
          })}
        >
          {menuItems}
        </Box>
      </Menu>
    </Dropdown>
  );
};

export default LanguageSelector;
