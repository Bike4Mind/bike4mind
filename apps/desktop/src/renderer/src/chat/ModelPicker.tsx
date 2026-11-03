import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Chip from '@mui/joy/Chip';
import DialogActions from '@mui/joy/DialogActions';
import DialogContent from '@mui/joy/DialogContent';
import DialogTitle from '@mui/joy/DialogTitle';
import Dropdown from '@mui/joy/Dropdown';
import Input from '@mui/joy/Input';
import Menu from '@mui/joy/Menu';
import MenuButton from '@mui/joy/MenuButton';
import MenuItem from '@mui/joy/MenuItem';
import Modal from '@mui/joy/Modal';
import ModalDialog from '@mui/joy/ModalDialog';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import type { ChatModelOption } from '@shared/chat';
import { findModelOption, isLocalModel, parseLocalModelId } from '@shared/chat';
import { LOCAL_SERVER_ID, serverIdOfRuntime } from '@shared/modelServers';
import { CloudIcon, ServerIcon } from './icons';
import {
  changeFilters as nextFilters,
  effectiveFilters,
  filterOptions,
  type FilterOptions,
  filtersActive,
  matchesFilters,
  matchesQuery,
  modelLocation,
  modelProvider,
  modelServer,
  needsHostedSwitchConfirm,
  NO_FILTERS,
  type ModelPickerFilters,
  type ServerRef,
  useModelPickerFilters,
  visibleControls,
} from './modelPickerFilters';
import type { NoLocalModels } from './noLocalModels';
import { formatCredits } from './statusLine';
import type { ModelCatalogController } from './useChat';

/** Above this the list is long enough that scanning it beats scrolling it. */
const FILTER_THRESHOLD = 8;

/** Keys the menu, not the filter box, should act on - navigation, and the way out. */
const MENU_KEYS = new Set(['ArrowDown', 'ArrowUp', 'Home', 'End', 'PageUp', 'PageDown', 'Tab', 'Escape']);

function shortLabel(models: readonly ChatModelOption[], modelId: string): string {
  return findModelOption(models, modelId)?.name ?? modelId;
}

interface ModelGroup {
  key: string;
  /** Null when there is only one group, which needs no heading. */
  label: string | null;
  models: ChatModelOption[];
}

/**
 * This computer, each saved server in list order, then hosted, from whatever the filters left;
 * headed whenever more than one remains. Local first because those lists are short and chosen by
 * the user, and hosted models carry the release dates that order the long tail.
 */
export function groupByServer(models: readonly ChatModelOption[]): ModelGroup[] {
  const hosted: ModelGroup = { key: 'hosted', label: 'Hosted', models: [] };
  const local = new Map<string, ModelGroup>();
  for (const model of models) {
    const server = modelServer(model);
    if (!server) {
      hosted.models.push(model);
      continue;
    }
    const group = local.get(server.id) ?? { key: server.id, label: server.name, models: [] };
    group.models.push(model);
    local.set(server.id, group);
  }
  const thisComputer = local.get(LOCAL_SERVER_ID);
  const servers = [...(thisComputer ? [thisComputer] : []), ...[...local.values()].filter(g => g !== thisComputer)];
  const groups = [...servers, hosted].filter(group => group.models.length);
  return groups.length === 1 ? [{ ...groups[0]!, label: null }] : groups;
}

/**
 * Newest release first, undated after, each run in its incoming order - except that a model listed
 * under several providers (one name, same date) keeps its rows together so they read as one choice.
 * Only hosted models carry dates; local ones keep catalog order inside their own groups.
 */
export function sortByRecency(models: readonly ChatModelOption[]): ChatModelOption[] {
  const firstOfName = new Map<string, number>();
  models.forEach((model, index) => firstOfName.set(model.name, firstOfName.get(model.name) ?? index));
  return models
    .map((model, index) => ({ model, index }))
    .sort((a, b) => {
      const [da, db] = [a.model.releaseDate, b.model.releaseDate];
      if (da !== db) {
        if (da && db) return da < db ? 1 : -1;
        return da ? -1 : 1;
      }
      return firstOfName.get(a.model.name)! - firstOfName.get(b.model.name)! || a.index - b.index;
    })
    .map(entry => entry.model);
}

/** A hosted row names its provider and a local row its server, even when filtered to it. */
function providerLabel(model: ChatModelOption): string | undefined {
  return modelServer(model)?.name ?? model.backend;
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

/** The first selectable model row of the menu the filter box sits in - the one the query narrowed to. */
function topMatch(filterInput: HTMLElement): HTMLElement | null {
  return (
    filterInput
      .closest('[role="menu"]')
      ?.querySelector<HTMLElement>('[data-testid="model-picker-option"]:not([data-unavailable])') ?? null
  );
}

function SwitchCost({ credits }: { credits: number | null }) {
  if (credits === null) return null;
  return (
    <Typography
      level="body-xs"
      textColor="warning.plainColor"
      noWrap
      title={`About ${formatCredits(credits)} credits to re-read this chat`}
      aria-label={`About ${formatCredits(credits)} credits to re-read this chat`}
      sx={{ flexShrink: 0 }}
      data-testid="model-picker-switch-cost"
    >
      ~{formatCredits(credits)} cr
    </Typography>
  );
}

function serverPhrase(server: ServerRef): string {
  return server.id === LOCAL_SERVER_ID ? 'this computer' : server.name;
}

/** Where a local model id runs, from the catalog entry or, when that is missing, from the id itself. */
function whereModelRuns(modelId: string, current: ChatModelOption | undefined, servers: readonly ServerRef[]): string {
  const listed = current && modelServer(current);
  if (listed) return serverPhrase(listed);
  const runtimeId = parseLocalModelId(modelId)?.runtimeId;
  const serverId = runtimeId ? serverIdOfRuntime(runtimeId) : null;
  if (!serverId) return 'this computer';
  return servers.find(server => server.id === serverId)?.name ?? 'a saved model server';
}

/** Where a row's model runs, so a hosted pick never looks like a local one. */
function LocationMark({ model, warn }: { model: ChatModelOption; warn: boolean }) {
  const server = modelServer(model);
  const label = server ? `Runs on ${serverPhrase(server)}` : 'Hosted: messages go to Bike4Mind';
  return (
    <Box
      component="span"
      role="img"
      aria-label={label}
      title={label}
      data-testid="model-picker-option-location"
      data-location={modelLocation(model)}
      sx={{ display: 'flex', flexShrink: 0, color: warn ? 'warning.plainColor' : 'text.tertiary' }}
    >
      {server ? <ServerIcon size={14} /> : <CloudIcon size={14} />}
    </Box>
  );
}

function FilterChip({
  selected,
  label,
  onClick,
  testId,
}: {
  selected: boolean;
  label: string;
  onClick: () => void;
  testId: string;
}) {
  return (
    <Chip
      size="sm"
      variant={selected ? 'soft' : 'plain'}
      color={selected ? 'primary' : 'neutral'}
      onClick={onClick}
      slotProps={{ action: { 'data-testid': testId, role: 'menuitemradio', 'aria-checked': selected } }}
    >
      {label}
    </Chip>
  );
}

/** Hosted or local, then a provider or a server. Rows with nothing to choose between are left out. */
function FilterControls({
  filters,
  options,
  onChange,
}: {
  filters: ModelPickerFilters;
  options: FilterOptions;
  onChange: (change: Partial<ModelPickerFilters>) => void;
}) {
  const shown = visibleControls(filters, options);
  if (!shown.location && !shown.providers && !shown.servers) return null;
  const row = { px: 1, pb: 0.5, gap: 0.25, flexWrap: 'wrap' } as const;
  return (
    <Box data-testid="model-picker-filters">
      {shown.location && (
        <Stack direction="row" role="group" aria-label="Location" sx={row}>
          {(options.hasLocal ? (['all', 'hosted', 'local'] as const) : (['all', 'hosted'] as const)).map(location => (
            <FilterChip
              key={location}
              selected={filters.location === location}
              label={location === 'all' ? 'All' : location === 'hosted' ? 'Hosted' : 'Local'}
              onClick={() => onChange({ location })}
              testId={`model-picker-location-${location}`}
            />
          ))}
        </Stack>
      )}
      {shown.providers && (
        <Stack direction="row" role="group" aria-label="Provider" sx={row}>
          <FilterChip
            selected={!filters.provider}
            label="Any provider"
            onClick={() => onChange({ provider: null })}
            testId="model-picker-provider-any"
          />
          {options.providers.map(provider => (
            <FilterChip
              key={provider}
              selected={filters.provider === provider}
              label={provider}
              onClick={() => onChange({ provider })}
              testId={`model-picker-provider-${provider}`}
            />
          ))}
        </Stack>
      )}
      {shown.servers && (
        <Stack direction="row" role="group" aria-label="Server" sx={row}>
          <FilterChip
            selected={!filters.server}
            label="Any server"
            onClick={() => onChange({ server: null })}
            testId="model-picker-server-any"
          />
          {options.servers.map(server => (
            <FilterChip
              key={server.id}
              selected={filters.server === server.id}
              label={server.name}
              onClick={() => onChange({ server: server.id })}
              testId={`model-picker-server-${server.id}`}
            />
          ))}
        </Stack>
      )}
    </Box>
  );
}

/** Asked before a conversation that has stayed local moves to a hosted model. */
function HostedSwitchDialog({
  where,
  to,
  onConfirm,
  onCancel,
}: {
  /** Where the conversation runs now, as a phrase ("this computer", a server's name). */
  where: string;
  to: ChatModelOption;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const provider = modelProvider(to);
  return (
    <Modal open onClose={onCancel}>
      <ModalDialog size="sm" data-testid="model-picker-hosted-dialog">
        <DialogTitle>Send this conversation to Bike4Mind?</DialogTitle>
        <DialogContent>
          This conversation is on {where}. With {to.name}
          {provider ? ` (${provider})` : ''}, your next message sends the whole conversation to Bike4Mind for a hosted
          model to answer, including any messages and tool results that have only been on {where} so far.
        </DialogContent>
        <DialogActions>
          <Button color="warning" onClick={onConfirm} data-testid="model-picker-hosted-confirm-btn">
            Switch to {to.name}
          </Button>
          <Button variant="plain" onClick={onCancel} data-testid="model-picker-hosted-cancel-btn">
            Stay local
          </Button>
        </DialogActions>
      </ModalDialog>
    </Modal>
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
  switchCredits,
  servers,
  hasHistory,
  sessionId,
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
  /** Credits the first turn on another model spends re-reading this conversation, or null to say nothing. */
  switchCredits?: (model: ChatModelOption) => number | null;
  /** Saved model servers, offered as filters even when they list no chat model. */
  servers?: readonly ServerRef[];
  /** The conversation has messages, so moving it from a local model to a hosted one sends them. */
  hasHistory: boolean;
  /** The conversation the picker is acting for; a pending hosted-switch question is dropped when it changes. */
  sessionId: string | null;
}) {
  const [filter, setFilter] = useState('');
  const [savedFilters, setFilters] = useModelPickerFilters();
  const [pendingHosted, setPendingHosted] = useState<{ model: ChatModelOption; key: string } | null>(null);
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
  const current = findModelOption(models, modelId);
  const missing = !!modelId && models.length > 0 && !current;
  // Local mode: a hosted id or the placeholder is replaced by main as soon as it sees a list.
  const selecting = missing && local && !parseLocalModelId(modelId);
  const unavailable = missing && !selecting;
  const serverDown = current?.unavailable;

  const details = useMemo(() => rowDetails(models), [models]);
  const options = useMemo(() => filterOptions(models, servers), [models, servers]);
  const filters = useMemo(() => effectiveFilters(savedFilters, options), [savedFilters, options]);
  const matches = useMemo(
    () =>
      sortByRecency(models).filter(
        model => matchesFilters(model, filters) && matchesQuery(model, filter, details.get(model.id))
      ),
    [models, details, filter, filters]
  );
  const groups = useMemo(() => groupByServer(matches), [matches]);
  const warnHosted = hasHistory && !!modelId && isLocalModel(modelId);
  const emptyServer =
    filters.server && !models.some(model => modelServer(model)?.id === filters.server)
      ? options.servers.find(server => server.id === filters.server)?.name
      : undefined;
  const changeFilters = (change: Partial<ModelPickerFilters>) => setFilters(nextFilters(filters, change));

  // A question asked about one conversation's model must not be answered for another's.
  const pendingKey = `${sessionId ?? ''}\n${modelId ?? ''}`;
  const pending = pendingHosted?.key === pendingKey ? pendingHosted.model : null;
  useEffect(() => setPendingHosted(null), [pendingKey]);

  const choose = (model: ChatModelOption) => {
    if (needsHostedSwitchConfirm(modelId, model, hasHistory)) setPendingHosted({ model, key: pendingKey });
    else onSelect(model.id);
  };

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

      <Menu size="sm" placement="top-start" sx={{ maxHeight: 400, overflow: 'auto', minWidth: 320, maxWidth: 440 }}>
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

        {models.length > 0 && <FilterControls filters={filters} options={options} onChange={changeFilters} />}

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
                {group.key === 'hosted' && warnHosted && (
                  <Typography component="span" fontWeight="md" textColor="warning.plainColor">
                    {' '}
                    - sends this conversation to Bike4Mind
                  </Typography>
                )}
              </Typography>
            )}
            {group.models.map(model => (
              <MenuItem
                key={model.id}
                selected={model.id === current?.id}
                disabled={!!model.unavailable}
                onClick={() => choose(model)}
                data-testid="model-picker-option"
                data-unavailable={model.unavailable ? 'true' : undefined}
                sx={{ minBlockSize: 0, py: 0.25, gap: 1 }}
              >
                <LocationMark model={model} warn={warnHosted && modelLocation(model) === 'hosted'} />
                <Typography level="body-sm" noWrap sx={{ flex: '1 1 auto', minWidth: 0 }}>
                  {model.id === current?.id ? '\u2022 ' : ''}
                  {model.name}
                </Typography>
                {details.get(model.id) && (
                  <Typography
                    level="body-xs"
                    textColor="text.tertiary"
                    noWrap
                    title={details.get(model.id)}
                    sx={{ flex: '0 1 auto', minWidth: 0, maxWidth: '55%' }}
                    data-testid="model-picker-option-detail"
                  >
                    {details.get(model.id)}
                  </Typography>
                )}
                {!model.unavailable && model.id !== modelId && switchCredits && (
                  <SwitchCost credits={switchCredits(model)} />
                )}
              </MenuItem>
            ))}
          </Box>
        ))}

        {models.length > 0 && matches.length === 0 && (
          <Stack direction="row" alignItems="center" spacing={1} sx={{ px: 1.5, py: 0.5 }}>
            <Typography
              level="body-xs"
              textColor="text.tertiary"
              sx={{ whiteSpace: 'normal' }}
              data-testid="model-picker-no-match"
            >
              {emptyServer && !filter.trim()
                ? `${emptyServer} lists no chat models.`
                : filter.trim()
                  ? `Nothing matches "${filter}"${filtersActive(filters) ? ' with these filters' : ''}.`
                  : 'No models match these filters.'}
            </Typography>
            {filtersActive(filters) && (
              // A button, not a MenuItem: activating a MenuItem closes the menu.
              <Button
                size="sm"
                variant="plain"
                onClick={() => setFilters(NO_FILTERS)}
                sx={{ flexShrink: 0 }}
                data-testid="model-picker-clear-filters-btn"
              >
                Clear filters
              </Button>
            )}
          </Stack>
        )}

        <MenuItem onClick={() => void catalog.reload()} data-testid="model-picker-reload">
          <Typography level="body-xs" textColor="text.tertiary">
            Refresh list
          </Typography>
        </MenuItem>
      </Menu>
      {/* Portals out of the Dropdown; it opens once the row's click has closed the menu. */}
      {pending && modelId && (
        <HostedSwitchDialog
          where={whereModelRuns(modelId, current, options.servers)}
          to={pending}
          onConfirm={() => {
            setPendingHosted(null);
            onSelect(pending.id);
          }}
          onCancel={() => setPendingHosted(null)}
        />
      )}
    </Dropdown>
  );
}
