import { Box, Tooltip, Typography } from '@mui/joy';
import { FC } from 'react';

export interface SwitchSelectorOption {
  value: string;
  label?: string;
  icon?: React.ComponentType;
  tooltip?: string;
}

interface SwitchSelectorProps {
  options: SwitchSelectorOption[];
  value: string;
  onChange: (value: string) => void;
  width?: number | string;
}

const SwitchSelector: FC<SwitchSelectorProps> = ({ options, value, onChange, width = 48 * options.length }) => {
  const selectedIdx = options.findIndex(opt => opt.value === value);

  return (
    <Box
      sx={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        width,
        height: '32px',
        borderRadius: '6px',
        background: theme => theme.palette.common.switchSelector.background,
        border: theme => `1px solid ${theme.palette.neutral.outlinedBorder}`,
        boxShadow: 'none',
        cursor: 'pointer',
        userSelect: 'none',
        overflow: 'hidden',
      }}
    >
      {/* Sliding indicator */}
      <Box
        sx={{
          position: 'absolute',
          left: `calc(4px + ${selectedIdx} * (100% / ${options.length}))`,
          width: `calc(100% / ${options.length} - 8px)`,
          height: '24px',
          borderRadius: '4px',
          background: theme => theme.palette.primary.solidBg,
          boxShadow: 'md',
          transition: 'left 0.25s cubic-bezier(0.4,0,0.2,1)',
          zIndex: 1,
        }}
      />
      {options.map(({ value: v, label, icon: Icon, tooltip }, idx) => {
        const content = (
          <Box
            key={v}
            data-testid={`view-mode-${v}`}
            onClick={() => onChange(v)}
            sx={{
              zIndex: 2,
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'color 0.2s',
              cursor: 'pointer',
              height: '100%',
              position: 'relative',
              ...(selectedIdx !== idx && {
                '&:hover::before': {
                  content: '""',
                  position: 'absolute',
                  top: '4px',
                  left: '4px',
                  right: '4px',
                  bottom: '4px',
                  backgroundColor: theme => theme.palette.notebooklist.hoverBg,
                  borderRadius: '4px',
                  zIndex: -1,
                },
              }),
            }}
          >
            <Typography
              sx={{
                color: selectedIdx === idx ? 'white' : theme => theme.palette.common.switchSelector.lightTextColor,
                fontSize: '12px',
                fontWeight: selectedIdx === idx ? 500 : 400,
                lineHeight: '150%',
              }}
            >
              {label}
            </Typography>
          </Box>
        );
        return tooltip ? (
          <Tooltip key={v} title={tooltip} placement="top">
            {content}
          </Tooltip>
        ) : (
          content
        );
      })}
    </Box>
  );
};

export default SwitchSelector;
