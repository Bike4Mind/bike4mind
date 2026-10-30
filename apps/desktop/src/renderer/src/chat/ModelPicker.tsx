import { useCallback, useMemo, useRef, useState } from 'react';
import Box from '@mui/joy/Box';
import Dropdown from '@mui/joy/Dropdown';
import Input from '@mui/joy/Input';
import Menu from '@mui/joy/Menu';
import MenuButton from '@mui/joy/MenuButton';
import MenuItem from '@mui/joy/MenuItem';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import type { ChatModelOption } from '@shared/chat';
import { isLocalModel, parseLocalModelId } from '@shared/chat';
import { LOCAL_SERVER_ID, LOCAL_SERVER_NAME } from '@shared/modelServers';
import type { NoLocalModels } from './noLocalModels';
import type { ModelCatalogController } from './useChat';

/** Above this the list is long enough that scanning it beats scrolling it. */
const FILTER_THRESHOLD = 8;

/** Keys the menu, not the filter box, should act on - navigation, and the way out. */
const MENU_KEYS = new Set(['ArrowDown', 'ArrowUp', 'Home', 'End', 'PageUp', 'PageDown', 'Tab', 'Escape']);

function shortLabel(models: readonly ChatModelOption[], modelId: string): string {
  return models.find(model => model.id === modelId)?.name ?? modelId;
}

interface ModelGroup {
  key: string;
  /** Null when there is only one group, which needs no heading. */
  label: string | null;
  models: ChatModelOption[];
}

/**
 * Hosted models first, then this computer's, then each saved server's in list order. Flat (one
 * unlabelled group) until a saved server contributes a model.
 */
export function groupByServer(models: readonly ChatModelOption[]): ModelGroup[] {
  if (!models.some(model => model.server))
    return models.length ? [{ key: 'all', label: null, models: [...models] }] : [];
  const groups = new Map<string, ModelGroup>();
  const add = (key: string, label: string, model: ChatModelOption) => {
    const group = groups.get(key) ?? { key, label, models: [] };
    group.models.push(model);
    groups.set(key, group);
  };
  for (const model of models.filter(model => !isLocalModel(model.id))) add('hosted', 'Hosted', model);
  for (const model of models.filter(model => isLocalModel(model.id) && !model.server))
    add(LOCAL_SERVER_ID, LOCAL_SERVER_NAME, model);
  for (const model of models) if (model.server) add(model.server.id, model.server.name, model);
  return [...groups.values()];
}

/** Newest release first; undated models (local, saved servers) follow, each run in its incoming order. */
export function sortByRecency(models: readonly ChatModelOption[]): ChatModelOption[] {
  return [...models].sort((a, b) => {
    if (a.releaseDate && b.releaseDate)
      return a.releaseDate < b.releaseDate ? 1 : a.releaseDate > b.releaseDate ? -1 : 0;
    return a.releaseDate ? -1 : b.releaseDate ? 1 : 0;
  });
}

/** A saved server's rows sit under its own heading, so they name no provider. */
function providerLabel(model: ChatModelOption): string | undefined {
  return model.server ? undefined : model.backend;
}

/**
 * Each row's visible secondary line, keyed by model id. Unavailable reasons replace provider/id
 * details so filtering and rendering agree even when a server goes down.
 */
export function rowDetails(models: readonly ChatModelOption[]): Map<string, string | undefined> {
  const rowKey = (model: ChatModelOption) => `${model.server?.id ?? ''}\n${model.name}\n${providerLabel(model) ?? ''}`;
  const counts = new Map<string, number>();
  for (const model of models) counts.set(rowKey(model), (counts.get(rowKey(model)) ?? 0) + 1);
  return new Map(
    models.map(model => {
      if (model.unavailable !== undefined) return [model.id, model.unavailable];
      const provider =
        [providerLabel(model), model.baseModel && `LoRA on ${model.baseModel}`].filter(Boolean).join(' - ') ||
        undefined;
      if ((counts.get(rowKey(model)) ?? 0) < 2) return [model.id, provider];
      return [model.id, provider ? `${provider} - ${model.id}` : model.id];
    })
  );
}

/** The first model row of the menu the filter box sits in - the one the query narrowed to. */
function topMatch(filterInput: HTMLElement): HTMLElement | null {
  return (
    filterInput.closest('[role="menu"]')?.querySelector<HTMLElement>('[data-testid="model-picker-option"]') ?? null
  );
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
  noLocal,
  onOpenModels,
  local,
}: {
  catalog: ModelCatalogController;
  /** The conversation's saved model. May not be in `catalog.models` - see `unavailable`. */
  modelId: string | null;
  disabled?: boolean;
  onSelect: (model: string) => void;
  /** Signed out with no device model: the picker names that instead of the saved model. */
  noLocal?: NoLocalModels | null;
  onOpenModels?: () => void;
  /** Signed out: models are on this device, not on a server. */
  local?: boolean;
}) {
  const [filter, setFilter] = useState('');
  const { models, loading, error } = catalog;

  /** False once the user has asked to leave the filter box - see `bindFilter`. */
  const holdFilter = useRef(true);

  /**
   * Holds focus in the filter box while a query is being typed.
   *
   * Joy's menu re-focuses its highlighted item every time the set of items changes, and it only
   * declines to when the focus it would steal is OUTSIDE the menu - which a filter box sitting
   * inside the menu never is. Every keystroke narrows the list, so without this the box loses
   * focus after one character and the rest of the query goes nowhere.
   *
   * It has to be an event listener rather than an effect keyed on the matches: the steal lands in
   * the render AFTER the one that narrowed the list, which an effect of ours does not see. Taking
   * focus back on `focusin` catches it whenever it happens. Navigation keys clear `holdFilter`
   * first, so arrowing into the list still works.
   */
  const bindFilter = useCallback((node: HTMLInputElement | null) => {
    const menu = node?.closest('[role="menu"]');
    if (!node || !menu) return;
    holdFilter.current = true;
    node.focus({ preventScroll: true });
    const restore = (event: Event) => {
      if (event.target === node) {
        holdFilter.current = true; // clicked back into the box after arrowing away
        return;
      }
      // `preventScroll` or the menu scrolls back to the top on every wheel tick: scrolling moves
      // rows under a stationary pointer, Joy focuses the row it thinks is hovered, and bringing
      // focus back here would scroll this box - the menu's first child - into view.
      if (holdFilter.current) node.focus({ preventScroll: true });
    };
    menu.addEventListener('focusin', restore);
    return () => menu.removeEventListener('focusin', restore);
  }, []);

  // A saved model missing from a list that LOADED is genuinely gone from this deployment.
  // While the list is empty because it could not be read, nothing is known, so nothing is said.
  const missing = !!modelId && models.length > 0 && !models.some(model => model.id === modelId);
  // Local mode: a hosted id or the placeholder is replaced by main as soon as it sees a list.
  const selecting = missing && local && !parseLocalModelId(modelId);
  const unavailable = missing && !selecting;
  const serverDown = models.find(model => model.id === modelId)?.unavailable;

  const details = useMemo(() => rowDetails(models), [models]);
  const matches = useMemo(() => {
    const query = filter.trim().toLowerCase();
    const sorted = sortByRecency(models);
    if (!query) return sorted;
    return sorted.filter(model =>
      [model.name, details.get(model.id)].some(text => text?.toLowerCase().includes(query))
    );
  }, [models, details, filter]);
  const groups = useMemo(() => groupByServer(matches), [matches]);

  const label =
    noLocal && models.length === 0
      ? 'No local model'
      : selecting
        ? 'Selecting model...'
        : modelId
          ? shortLabel(models, modelId)
          : 'No conversation';

  return (
    <Dropdown onOpenChange={(_event, open) => open && setFilter('')}>
      <MenuButton
        size="sm"
        variant="plain"
        color={unavailable || serverDown ? 'warning' : 'neutral'}
        disabled={disabled}
        sx={{ fontWeight: 'normal', minWidth: 0 }}
        slotProps={{ root: { 'data-testid': 'model-picker-btn' } }}
      >
        <Typography level="body-xs" noWrap textColor="inherit">
          {label}
          {unavailable || serverDown ? ' (unavailable)' : ''}
        </Typography>
      </MenuButton>

      <Menu size="sm" placement="top-start" sx={{ maxHeight: 360, overflow: 'auto', minWidth: 280 }}>
        {models.length > FILTER_THRESHOLD && (
          <Box sx={{ px: 1, pb: 0.5 }}>
            <Input
              size="sm"
              value={filter}
              placeholder="Filter models..."
              onChange={event => setFilter(event.target.value)}
              onKeyDown={event => {
                // A typed query has one obvious answer, so Enter takes it rather than making the
                // user arrow down into a list they just narrowed to the thing they wanted. It
                // clicks the row rather than calling `onSelect` here, because only the row's own
                // click also closes the menu: Joy's Dropdown re-asserts its internal open state
                // over an `open` prop driven from outside. And the click has to leave this
                // handler first - dispatched from inside the keydown, the close never lands.
                if (event.key === 'Enter' && filter.trim() && matches.length > 0) {
                  event.stopPropagation();
                  const row = topMatch(event.currentTarget);
                  queueMicrotask(() => row?.click());
                  return;
                }
                if (MENU_KEYS.has(event.key)) {
                  holdFilter.current = false;
                  return;
                }
                // Typing must reach the box: Joy's menu treats printable keys as type-ahead and
                // moves the highlight instead, which eats every character after the first.
                event.stopPropagation();
              }}
              slotProps={{ input: { ref: bindFilter, 'data-testid': 'model-picker-filter' } }}
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
            This conversation is set to {modelId}, which{' '}
            {local ? 'is not installed on this device' : 'this server does not offer'}. Pick another; otherwise the next
            message switches automatically.
          </Typography>
        )}

        {loading && models.length === 0 && (
          <Typography level="body-xs" textColor="text.tertiary" sx={{ px: 1.5, py: 0.5 }}>
            Loading models...
          </Typography>
        )}

        {noLocal && (
          // A menu item rather than loose text so keyboard and screen-reader users reach it; it rechecks on activation.
          <MenuItem
            onClick={() => void catalog.reload()}
            sx={{ whiteSpace: 'normal', alignItems: 'flex-start' }}
            data-testid="model-picker-no-local"
          >
            <Typography level="body-xs" textColor="text.tertiary">
              {noLocal.reason}
            </Typography>
          </MenuItem>
        )}

        {noLocal?.fix === 'open-models' && onOpenModels && (
          <MenuItem onClick={onOpenModels} data-testid="model-picker-open-models-item">
            Open Models
          </MenuItem>
        )}

        {!noLocal && !loading && error && (
          <Box sx={{ px: 1.5, py: 0.5 }}>
            <Typography level="body-xs" textColor="danger.plainColor" sx={{ whiteSpace: 'normal' }}>
              {error}
            </Typography>
          </Box>
        )}

        {!noLocal && !loading && !error && models.length === 0 && (
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

        {serverDown && (
          <Typography
            level="body-xs"
            textColor="warning.plainColor"
            sx={{ px: 1.5, py: 0.5, whiteSpace: 'normal' }}
            data-testid="model-picker-server-down"
          >
            This conversation is set to {modelId}, but {serverDown}. Pick another model, or check the server under
            Settings, Model servers.
          </Typography>
        )}

        {groups.map(group => (
          <Box key={group.key} data-testid="model-picker-group" data-group={group.key}>
            {group.label && (
              <Typography
                level="body-xs"
                fontWeight="lg"
                textColor="text.tertiary"
                sx={{ px: 1.5, pt: 1, pb: 0.25 }}
                data-testid="model-picker-group-label"
              >
                {group.label}
              </Typography>
            )}
            {group.models.map(model => (
              <MenuItem
                key={model.id}
                selected={model.id === modelId}
                disabled={!!model.unavailable}
                onClick={() => onSelect(model.id)}
                data-testid="model-picker-option"
                data-unavailable={model.unavailable ? 'true' : undefined}
              >
                <Stack sx={{ minWidth: 0 }}>
                  <Typography level="body-sm" noWrap>
                    {model.id === modelId ? '\u2022 ' : ''}
                    {model.name}
                  </Typography>
                  {details.get(model.id) && (
                    <Typography
                      level="body-xs"
                      textColor="text.tertiary"
                      noWrap
                      data-testid="model-picker-option-detail"
                    >
                      {details.get(model.id)}
                    </Typography>
                  )}
                </Stack>
              </MenuItem>
            ))}
          </Box>
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
