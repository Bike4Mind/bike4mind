import Dropdown from '@mui/joy/Dropdown';
import Menu from '@mui/joy/Menu';
import MenuButton from '@mui/joy/MenuButton';
import MenuItem from '@mui/joy/MenuItem';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import { PROMPT_CACHE_TTLS, type PromptCacheTtl } from '@bike4mind/common';
import type { ChatModelOption } from '@shared/chat';
import { modelSwitchCredits } from './modelSwitchCost';

const creditFormat = new Intl.NumberFormat('en-US');

const CHOICES: Record<PromptCacheTtl, { label: string; description: string }> = {
  '5m': { label: '5 minutes', description: 'Cheapest to write. Expires after 5 idle minutes.' },
  '1h': { label: '1 hour', description: 'Twice the input price to write. Survives longer breaks.' },
};

/**
 * How long the server keeps this conversation's prompt cache, beside the effort picker. Rendered
 * only for a model that takes the 1-hour TTL; each option shows what re-writing the current
 * context at that TTL would cost, so the trade is visible before it is made.
 */
export function PromptCacheTtlPicker({
  model,
  ttl,
  contextTokens,
  disabled,
  onSelect,
}: {
  model: ChatModelOption | undefined;
  ttl: PromptCacheTtl;
  contextTokens: number;
  disabled?: boolean;
  onSelect: (ttl: PromptCacheTtl) => void;
}) {
  if (!model?.supportsOneHourCache) return null;

  return (
    <Dropdown>
      <MenuButton
        size="sm"
        variant="plain"
        color="neutral"
        disabled={disabled}
        sx={{ fontWeight: 'normal', minWidth: 0 }}
        slotProps={{ root: { 'data-testid': 'prompt-cache-ttl-picker-btn' } }}
      >
        <Typography level="body-xs" noWrap textColor="inherit">
          Cache: {ttl}
        </Typography>
      </MenuButton>
      <Menu size="sm" placement="top-start" sx={{ minWidth: 260 }} data-testid="prompt-cache-ttl-picker-menu">
        {PROMPT_CACHE_TTLS.map(choice => {
          const credits = modelSwitchCredits(model, contextTokens, choice);
          return (
            <MenuItem
              key={choice}
              selected={choice === ttl}
              onClick={() => onSelect(choice)}
              data-testid={`prompt-cache-ttl-picker-option-${choice}`}
            >
              <Stack sx={{ minWidth: 0 }}>
                <Typography level="body-sm" noWrap>
                  {choice === ttl ? '\u2022 ' : ''}
                  {CHOICES[choice].label}
                </Typography>
                <Typography level="body-xs" textColor="text.tertiary" noWrap>
                  {CHOICES[choice].description}
                </Typography>
                {credits !== null && (
                  <Typography
                    level="body-xs"
                    textColor="text.tertiary"
                    noWrap
                    data-testid={`prompt-cache-ttl-picker-option-${choice}-price`}
                  >
                    About {creditFormat.format(credits)} credits to write this chat
                  </Typography>
                )}
              </Stack>
            </MenuItem>
          );
        })}
      </Menu>
    </Dropdown>
  );
}
