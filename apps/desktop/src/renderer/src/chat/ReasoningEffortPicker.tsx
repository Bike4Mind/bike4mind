import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Dropdown from '@mui/joy/Dropdown';
import Menu from '@mui/joy/Menu';
import MenuButton from '@mui/joy/MenuButton';
import MenuItem from '@mui/joy/MenuItem';
import Stack from '@mui/joy/Stack';
import Tooltip from '@mui/joy/Tooltip';
import Typography from '@mui/joy/Typography';
import { REASONING_EFFORT_SETTINGS, type ChatModelOption, type ReasoningEffortSetting } from '@shared/chat';

const LABELS: Record<ReasoningEffortSetting, string> = {
  default: 'Default',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

const DESCRIPTIONS: Record<ReasoningEffortSetting, string> = {
  default: 'Let the model decide how long to think.',
  minimal: 'Barely think. Fastest and cheapest.',
  low: 'A little thought before answering.',
  medium: 'A balance of speed and care.',
  high: 'Think hardest. Slowest and most expensive.',
};

/**
 * Whether this model would do anything with an effort, as far as the renderer can tell.
 *
 * Only a model the loaded catalog actually carries gives an answer. A list that has not loaded,
 * or a model that has been retired from one that has, says nothing - and a control disabled on
 * a guess would be a worse lie than the one this picker exists to avoid.
 */
function supportState(
  models: readonly ChatModelOption[],
  modelId: string | null
): { supported: boolean; known: boolean } {
  const option = modelId ? models.find(model => model.id === modelId) : undefined;
  if (!option || option.supportsReasoningEffort === undefined) return { supported: true, known: false };
  return { supported: option.supportsReasoningEffort, known: true };
}

/**
 * How hard this conversation's model thinks, beside the picker that chooses the model.
 *
 * The two belong together: which efforts mean anything is a property of the model, and only
 * the reasoning models accept one at all. On anything else the control is disabled and says
 * why, rather than quietly accepting a choice the next turn would drop on the floor.
 */
export function ReasoningEffortPicker({
  models,
  modelId,
  effort,
  disabled,
  onSelect,
}: {
  /** The loaded catalog, for the one flag this reads off the conversation's model. */
  models: readonly ChatModelOption[];
  modelId: string | null;
  effort: ReasoningEffortSetting;
  disabled?: boolean;
  onSelect: (effort: ReasoningEffortSetting) => void;
}) {
  const { supported, known } = supportState(models, modelId);
  const unsupported = known && !supported;
  const sx = { fontWeight: 'normal', minWidth: 0 } as const;

  if (unsupported) {
    return (
      <Tooltip
        placement="top"
        variant="soft"
        size="sm"
        sx={{ maxWidth: 280 }}
        title={`${modelId} does not take a reasoning effort. Only the OpenAI reasoning models do; Claude models have their own thinking settings.`}
      >
        {/* A disabled control fires no pointer events, so the tooltip needs something that does.
            A plain Button rather than a MenuButton: there is no Dropdown to belong to, because
            there is no menu worth opening. */}
        <Box component="span" sx={{ display: 'inline-flex' }} data-testid="effort-picker-unsupported">
          <Button
            size="sm"
            variant="plain"
            color="neutral"
            disabled
            sx={sx}
            slotProps={{ root: { 'data-testid': 'effort-picker-btn' } }}
          >
            <Typography level="body-xs" noWrap textColor="inherit">
              Effort: n/a
            </Typography>
          </Button>
        </Box>
      </Tooltip>
    );
  }

  return (
    <Dropdown>
      <MenuButton
        size="sm"
        variant="plain"
        color="neutral"
        disabled={disabled}
        sx={sx}
        slotProps={{ root: { 'data-testid': 'effort-picker-btn' } }}
      >
        <Typography level="body-xs" noWrap textColor="inherit">
          Effort: {LABELS[effort]}
        </Typography>
      </MenuButton>
      <Menu size="sm" placement="top-start" sx={{ minWidth: 240 }}>
        {REASONING_EFFORT_SETTINGS.map(setting => (
          <MenuItem
            key={setting}
            selected={setting === effort}
            onClick={() => onSelect(setting)}
            data-testid="effort-picker-option"
          >
            <Stack sx={{ minWidth: 0 }}>
              <Typography level="body-sm" noWrap>
                {setting === effort ? '\u2022 ' : ''}
                {LABELS[setting]}
              </Typography>
              <Typography level="body-xs" textColor="text.tertiary" noWrap>
                {DESCRIPTIONS[setting]}
              </Typography>
            </Stack>
          </MenuItem>
        ))}
      </Menu>
    </Dropdown>
  );
}
