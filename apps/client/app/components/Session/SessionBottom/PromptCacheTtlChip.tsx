import { FC } from 'react';
import { Box, Dropdown, ListItemDecorator, Menu, MenuButton, MenuItem, Typography } from '@mui/joy';
import CheckRoundedIcon from '@mui/icons-material/CheckRounded';
import { PROMPT_CACHE_TTLS, type PromptCacheTtl } from '@bike4mind/common';
import { STATUS_ITEM_HEIGHT, useStatusLineCompact } from './ComposerStatusLine';
import type { PromptCacheTtlPrices } from './promptCacheTtlPrices';

const creditFormat = new Intl.NumberFormat('en-US');

const TTL_LABEL: Record<PromptCacheTtl, string> = { '5m': '5 minutes', '1h': '1 hour' };
const TTL_SHORT: Record<PromptCacheTtl, string> = { '5m': '5m', '1h': '1h' };

interface PromptCacheTtlChipProps {
  value: PromptCacheTtl;
  prices: PromptCacheTtlPrices | null;
  onChange: (ttl: PromptCacheTtl) => void;
  disabled?: boolean;
}

/**
 * How long this chat's prompt cache lives between messages, on the composer's status line. Shown
 * only for models that take the 1-hour TTL (supportsOneHourPromptCache); each option states what
 * one cache write costs there.
 */
const PromptCacheTtlChip: FC<PromptCacheTtlChipProps> = ({ value, prices, onChange, disabled }) => {
  const compact = useStatusLineCompact();
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
        sx={{
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
        {compact ? TTL_SHORT[value] : `Cache ${TTL_SHORT[value]}`}
      </MenuButton>
      <Menu placement="top-end" size="sm" data-testid="prompt-cache-ttl-menu" sx={{ maxWidth: 300, zIndex: 1500 }}>
        <Box sx={{ px: 1.5, pt: 0.5, pb: 0.75 }}>
          <Typography level="body-xs">
            How long this chat stays cached between messages. Past it, the next message pays to cache the whole chat
            again. Reusing the cache costs the same either way.
          </Typography>
        </Box>
        {PROMPT_CACHE_TTLS.map(ttl => (
          <MenuItem
            key={ttl}
            data-testid={`prompt-cache-ttl-option-${ttl}`}
            selected={ttl === value}
            onClick={() => onChange(ttl)}
          >
            <ListItemDecorator>
              {ttl === value ? <CheckRoundedIcon sx={{ fontSize: '16px' }} /> : null}
            </ListItemDecorator>
            <Box sx={{ display: 'flex', flexDirection: 'column' }}>
              <Typography level="body-sm" textColor="text.primary">
                {TTL_LABEL[ttl]}
              </Typography>
              {priceLine(ttl) && (
                <Typography level="body-xs" data-testid={`prompt-cache-ttl-option-${ttl}-price`}>
                  {priceLine(ttl)}
                </Typography>
              )}
            </Box>
          </MenuItem>
        ))}
      </Menu>
    </Dropdown>
  );
};

export default PromptCacheTtlChip;
