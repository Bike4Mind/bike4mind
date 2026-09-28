import { useMemo, useState } from 'react';
import Box from '@mui/joy/Box';
import Dropdown from '@mui/joy/Dropdown';
import Input from '@mui/joy/Input';
import Menu from '@mui/joy/Menu';
import MenuButton from '@mui/joy/MenuButton';
import MenuItem from '@mui/joy/MenuItem';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import type { ChatModelOption } from '@shared/chat';
import type { ModelCatalogController } from './useChat';

/** Above this the list is long enough that scanning it beats scrolling it. */
const FILTER_THRESHOLD = 8;

function shortLabel(models: readonly ChatModelOption[], modelId: string): string {
  return models.find(model => model.id === modelId)?.name ?? modelId;
}

/**
 * Which model answers this conversation, changed without leaving it.
 *
 * Sits under the composer rather than in a settings route because the choice is part of asking
 * the question - the cost and capability of the next turn - and a user comparing two models on
 * one prompt should not have to navigate away between attempts.
 */
export function ModelPicker({
  catalog,
  modelId,
  disabled,
  onSelect,
}: {
  catalog: ModelCatalogController;
  /** The conversation's saved model. May not be in `catalog.models` - see `unavailable`. */
  modelId: string | null;
  disabled?: boolean;
  onSelect: (model: string) => void;
}) {
  const [filter, setFilter] = useState('');
  const { models, loading, error } = catalog;

  // A saved model missing from a list that LOADED is genuinely gone from this deployment.
  // While the list is empty because it could not be read, nothing is known, so nothing is said.
  const unavailable = !!modelId && models.length > 0 && !models.some(model => model.id === modelId);

  const matches = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!query) return models;
    return models.filter(model => model.id.toLowerCase().includes(query) || model.name.toLowerCase().includes(query));
  }, [models, filter]);

  const label = modelId ? shortLabel(models, modelId) : 'No conversation';

  return (
    <Dropdown onOpenChange={(_event, open) => open && setFilter('')}>
      <MenuButton
        size="sm"
        variant="plain"
        color={unavailable ? 'warning' : 'neutral'}
        disabled={disabled}
        sx={{ fontWeight: 'normal', minWidth: 0 }}
        slotProps={{ root: { 'data-testid': 'model-picker-btn' } }}
      >
        <Typography level="body-xs" noWrap textColor="inherit">
          {label}
          {unavailable ? ' (unavailable)' : ''}
        </Typography>
      </MenuButton>

      <Menu size="sm" placement="top-start" sx={{ maxHeight: 360, overflow: 'auto', minWidth: 280 }}>
        {models.length > FILTER_THRESHOLD && (
          <Box sx={{ px: 1, pb: 0.5 }}>
            <Input
              autoFocus
              size="sm"
              value={filter}
              placeholder="Filter models..."
              onChange={event => setFilter(event.target.value)}
              // Typing must reach the box: Joy's menu treats printable keys as type-ahead and
              // moves the highlight instead, which eats every character after the first.
              onKeyDown={event => event.stopPropagation()}
              slotProps={{ input: { 'data-testid': 'model-picker-filter' } }}
            />
          </Box>
        )}

        {unavailable && (
          <Typography
            level="body-xs"
            textColor="warning.plainColor"
            sx={{ px: 1.5, py: 0.5, whiteSpace: 'normal' }}
            data-testid="model-picker-unavailable"
          >
            This conversation is set to {modelId}, which this server does not offer. Pick another; otherwise the next
            message switches automatically.
          </Typography>
        )}

        {loading && models.length === 0 && (
          <Typography level="body-xs" textColor="text.tertiary" sx={{ px: 1.5, py: 0.5 }}>
            Loading models...
          </Typography>
        )}

        {!loading && error && (
          <Box sx={{ px: 1.5, py: 0.5 }}>
            <Typography level="body-xs" textColor="danger.plainColor" sx={{ whiteSpace: 'normal' }}>
              {error}
            </Typography>
          </Box>
        )}

        {!loading && !error && models.length === 0 && (
          <Typography
            level="body-xs"
            textColor="text.tertiary"
            sx={{ px: 1.5, py: 0.5, whiteSpace: 'normal' }}
            data-testid="model-picker-empty"
          >
            This server offers no models that can use tools. Add a provider key in its admin settings, or point a local
            Ollama at it.
          </Typography>
        )}

        {matches.map(model => (
          <MenuItem
            key={model.id}
            selected={model.id === modelId}
            onClick={() => onSelect(model.id)}
            data-testid="model-picker-option"
          >
            <Stack sx={{ minWidth: 0 }}>
              <Typography level="body-sm" noWrap>
                {model.id === modelId ? '• ' : ''}
                {model.name}
              </Typography>
              <Typography level="body-xs" textColor="text.tertiary" noWrap>
                {model.backend ? `${model.backend} - ` : ''}
                {model.id}
              </Typography>
            </Stack>
          </MenuItem>
        ))}

        {models.length > 0 && matches.length === 0 && (
          <Typography level="body-xs" textColor="text.tertiary" sx={{ px: 1.5, py: 0.5 }}>
            Nothing matches "{filter}".
          </Typography>
        )}

        <MenuItem onClick={() => void catalog.reload()} data-testid="model-picker-reload">
          <Typography level="body-xs" textColor="text.tertiary">
            Refresh list
          </Typography>
        </MenuItem>
      </Menu>
    </Dropdown>
  );
}
