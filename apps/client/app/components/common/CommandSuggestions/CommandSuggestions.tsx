import React from 'react';
import { Box, Typography } from '@mui/joy';
import { useCommandSuggestions } from '@client/app/hooks/useCommandSuggestions';
import { CommandSuggestionsProps } from './types';
import { brandAlpha } from '@client/app/utils/themes';
import { greenAlpha, green } from '@client/app/utils/themes/colors';
import { scrollbarStyles } from '@client/app/utils/scrollbarStyles';

const COMMON_STYLES = {
  container: {
    position: 'absolute' as const,
    bottom: '100%',
    left: 0,
    right: 0,
    mb: 2,
    border: '1px solid',
    borderColor: 'border.soft',
    backgroundColor: 'background.body',
    boxShadow: 'none',
    borderRadius: '8px',
    zIndex: 9999,
  },
  item: {
    cursor: 'pointer' as const,
    borderRadius: 'sm',
    p: '12px',
    transition: 'all 0.1s ease',
  },
  numberIndicator: {
    minWidth: 28,
    height: 28,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: '6px',
    fontSize: '14px',
    color: 'text.primary',
    mr: '12px',
    fontWeight: 'medium',
    backgroundColor: brandAlpha[400][5],
  },
};

export const CommandSuggestions: React.FC<CommandSuggestionsProps> = ({
  suggestions,
  input,
  onSelectSuggestion,
  onVisibilityChange,
  title,
  shouldShow,
  filterFn,
  maxWidth = '400px',
  variant = 'default',
}) => {
  const { filtered, selectedIndex, setSelectedIndex, selectSuggestion, isVisible } = useCommandSuggestions({
    suggestions,
    input,
    onSelectSuggestion,
    shouldShow,
    filterFn,
  });

  // Refs for each suggestion item to enable auto-scroll
  const itemRefs = React.useRef<(HTMLElement | null)[]>([]);

  // Notify parent of visibility state
  React.useEffect(() => {
    onVisibilityChange?.(isVisible);
  }, [isVisible, onVisibilityChange]);

  // Auto-scroll to selected item when selectedIndex changes
  React.useEffect(() => {
    if (selectedIndex !== null && itemRefs.current[selectedIndex]) {
      itemRefs.current[selectedIndex]?.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
      });
    }
  }, [selectedIndex]);

  if (!isVisible || filtered.length === 0) {
    return null;
  }

  const isCompact = variant === 'compact';

  return (
    <Box
      sx={{
        ...COMMON_STYLES.container,
        maxWidth,
      }}
    >
      {/* Header */}
      {(title || !isCompact) && <>{title}</>}

      <Box sx={{ p: 1, maxHeight: isCompact ? 240 : 300, overflowY: 'auto', ...scrollbarStyles }}>
        {filtered.map((suggestion, index) => {
          const isSelected = selectedIndex === index;
          return (
            <Box
              key={`${suggestion.command}-${index}`}
              ref={el => {
                itemRefs.current[index] = el as HTMLElement | null;
              }}
              onClick={() => selectSuggestion(suggestion)}
              onMouseEnter={() => setSelectedIndex(index)}
              sx={{
                ...COMMON_STYLES.item,
                display: 'flex',
                alignItems: 'center',
                background: theme => {
                  if (!isSelected) return theme.palette.background.surface2;

                  // Use more vibrant green for light mode, keep current for dark mode
                  const isLight = theme.palette.mode === 'light';
                  const greenStart = isLight ? greenAlpha[800][8] : greenAlpha[800][2];
                  const greenEnd = isLight ? greenAlpha[800][8] : greenAlpha[800][5];

                  return `linear-gradient(${greenStart}, ${greenEnd}), ${theme.palette.background.surface2}`;
                },
                border: theme => {
                  if (!isSelected) return '1px solid transparent';

                  // Use more vibrant green for light mode, keep current for dark mode
                  const isLight = theme.palette.mode === 'light';
                  const borderColor = isLight ? greenAlpha[800][50] : greenAlpha[800][30];

                  return `1px solid ${borderColor}`;
                },

                mb: 1,
                '&:last-child': {
                  mb: 0,
                },
              }}
            >
              <Box
                sx={{
                  ...COMMON_STYLES.numberIndicator,
                  backgroundColor: isSelected ? greenAlpha[800][20] : brandAlpha[400][5],
                  color: isSelected ? green[800] : 'text.primary',
                }}
              >
                {index < 9 ? index + 1 : ''}
              </Box>

              <Box sx={{ display: 'flex', flexDirection: 'column' }}>
                <Typography
                  level="body-xs"
                  sx={{
                    color: 'text.primary50',
                    lineHeight: 1.2,
                    mb: 0.5,
                    fontSize: '14px',
                  }}
                >
                  {suggestion.description}
                </Typography>

                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                  <Typography
                    level="body-xs"
                    sx={{
                      color: 'primary.solidBg',
                      fontSize: '14px',
                    }}
                  >
                    {suggestion.command}
                  </Typography>
                  <Typography level="body-xs" sx={{ color: 'text.primary', fontSize: '14px' }}>
                    {suggestion.example}
                  </Typography>
                </Box>
              </Box>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
};
