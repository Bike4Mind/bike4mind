import { FC } from 'react';
import { Box, Dropdown, Menu, MenuButton, MenuItem, Radio, Typography } from '@mui/joy';
import SdStorageOutlinedIcon from '@mui/icons-material/SdStorageOutlined';
import { PROMPT_CACHE_TTLS, type PromptCacheTtl } from '@bike4mind/common';
import { STATUS_ITEM_HEIGHT } from './ComposerStatusLine';
import type { PromptCacheTtlPrices } from './promptCacheTtlPrices';

const creditFormat = new Intl.NumberFormat('en-US');

const TTL_LABEL: Record<PromptCacheTtl, string> = { '5m': '5 minutes', '1h': '1 hour' };
const TTL_SHORT: Record<PromptCacheTtl, string> = { '5m': '5m', '1h': '1h' };

interface PromptCacheTtlChipProps {
  value: PromptCacheTtl;
  prices: PromptCacheTtlPrices | null;
  onChange: (ttl: PromptCacheTtl) => void;
  disabled?: boolean;
  /** False on a model that takes only the 5-minute TTL: the menu then just states it. */
  canChoose?: boolean;
}

/**
 * How long this chat's prompt cache lives between messages, on the composer's status line. Shown
 * only for models that take the 1-hour TTL (supportsOneHourPromptCache); each option states what
 * one cache write costs there.
 */
const PromptCacheTtlChip: FC<PromptCacheTtlChipProps> = ({ value, prices, onChange, disabled, canChoose = true }) => {
  const priceLine = (ttl: PromptCacheTtl): string | null => {
    if (!prices) return null;
    const credits = creditFormat.format(prices.credits[ttl]);
    return prices.basis === 'chat'
      ? `About ${credits} credits to cache this chat`
      : `About ${credits} credits per 100K tokens cached`;
  };

  return (
    <Dropdown>
      <MenuButton
        data-testid="prompt-cache-ttl-chip"
        aria-label={`Prompt cache: ${TTL_LABEL[value]}`}
        variant="plain"
        color="neutral"
        size="sm"
        disabled={disabled}
        startDecorator={<SdStorageOutlinedIcon sx={{ fontSize: '16px' }} />}
        sx={{
          '--Button-gap': '4px',
          height: STATUS_ITEM_HEIGHT,
          minHeight: 0,
          px: 0.75,
          borderRadius: '6px',
          fontSize: '12px',
          fontWeight: 400,
          whiteSpace: 'nowrap',
          color: 'var(--joy-palette-text-tertiary)',
        }}
      >
        {TTL_SHORT[value]}
      </MenuButton>
      {/* Same surface, title and radio rows as the sidenav Filters panel (FiltersPanel). */}
      <Menu
        placement="top-end"
        size="sm"
        data-testid="prompt-cache-ttl-menu"
        sx={theme => ({
          zIndex: 1500,
          width: 'max-content',
          maxWidth: 300,
          p: '16px 16px 12px 16px',
          gap: 0,
          backgroundColor: theme.palette.background.surface,
          border: `1px solid ${theme.palette.divider}`,
          borderRadius: '12px',
          boxShadow: 'none',
        })}
      >
        <Typography
          level="body-xs"
          sx={{ color: 'text.tertiary', fontSize: '12px', fontWeight: 400, letterSpacing: 0, mb: '4px' }}
        >
          PROMPT CACHE
        </Typography>
        <Typography level="body-xs" sx={{ color: 'text.tertiary', fontWeight: 400, mb: '12px' }}>
          {canChoose
            ? 'How long the chat stays cached. Past it, the next message re-caches it.'
            : 'This model caches the chat for 5 minutes. Past it, the next message re-caches it.'}
        </Typography>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {(canChoose ? PROMPT_CACHE_TTLS : (['5m'] as const)).map(ttl => {
            const selected = ttl === value;
            return (
              <MenuItem
                key={ttl}
                data-testid={`prompt-cache-ttl-option-${ttl}`}
                selected={selected}
                onClick={() => onChange(ttl)}
                sx={theme => ({
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px',
                  px: 1,
                  minHeight: '36px',
                  borderRadius: '8px',
                  backgroundColor: selected ? theme.palette.notebooklist.focusedBackground : 'transparent',
                  transition: 'background 0.15s',
                  '&:hover, &.Mui-focusVisible': {
                    outline: 'none',
                    backgroundColor: selected
                      ? theme.palette.notebooklist.focusedBackground
                      : theme.palette.notebooklist.hoverBg,
                  },
                  '&.Mui-selected': { backgroundColor: theme.palette.notebooklist.focusedBackground },
                })}
              >
                <Radio
                  checked={selected}
                  color="success"
                  size="sm"
                  tabIndex={-1}
                  readOnly
                  slotProps={{ input: { 'aria-hidden': true, tabIndex: -1 } }}
                  // The row shrinks before it wraps; a squeezed radio draws its ring as an oval.
                  sx={{
                    '--Radio-size': '20px',
                    flexShrink: 0,
                    '& .MuiRadio-icon': { width: '12px', height: '12px', borderRadius: '50%' },
                  }}
                />
                <Box sx={{ display: 'flex', flexDirection: 'column' }}>
                  <Typography level="body-sm" sx={{ fontWeight: 400, color: 'text.primary' }}>
                    {TTL_LABEL[ttl]}
                  </Typography>
                  {priceLine(ttl) && (
                    <Typography
                      level="body-xs"
                      data-testid={`prompt-cache-ttl-option-${ttl}-price`}
                      sx={{ color: 'text.tertiary', fontWeight: 400 }}
                    >
                      {priceLine(ttl)}
                    </Typography>
                  )}
                </Box>
              </MenuItem>
            );
          })}
        </Box>
      </Menu>
    </Dropdown>
  );
};

export default PromptCacheTtlChip;
