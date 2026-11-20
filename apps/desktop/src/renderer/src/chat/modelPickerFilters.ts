import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatModelOption } from '@shared/chat';
import { isLocalModel, parseLocalModelId } from '@shared/chat';
import { LOCAL_SERVER_ID, LOCAL_SERVER_NAME } from '@shared/modelServers';

export type ModelLocation = 'hosted' | 'local';
export type LocationFilter = 'all' | ModelLocation;

export interface ModelPickerFilters {
  location: LocationFilter;
  /** A hosted model's backend ("anthropic", "bedrock", ...), or null for any. */
  provider: string | null;
  /** A model server id, LOCAL_SERVER_ID for this computer, or null for any. */
  server: string | null;
}

export const NO_FILTERS: ModelPickerFilters = { location: 'all', provider: null, server: null };

export interface ServerRef {
  id: string;
  name: string;
}

export function modelLocation(model: Pick<ChatModelOption, 'id'>): ModelLocation {
  return isLocalModel(model.id) ? 'local' : 'hosted';
}

/** Where a local model runs: a saved server, else this computer. Null for a hosted model. */
export function modelServer(model: Pick<ChatModelOption, 'id' | 'server'>): ServerRef | null {
  if (!isLocalModel(model.id)) return null;
  return model.server ?? { id: LOCAL_SERVER_ID, name: LOCAL_SERVER_NAME };
}

/** The provider a hosted model is served through. Null for local models, whose backend names a runtime. */
export function modelProvider(model: Pick<ChatModelOption, 'id' | 'backend'>): string | null {
  return isLocalModel(model.id) ? null : (model.backend ?? null);
}

export interface FilterOptions {
  providers: string[];
  /** This computer first, then the saved servers, including any that list no chat model. */
  servers: ServerRef[];
  hasHosted: boolean;
  hasLocal: boolean;
}

export function filterOptions(
  models: readonly ChatModelOption[],
  savedServers: readonly ServerRef[] = []
): FilterOptions {
  const providers = new Set<string>();
  const servers = new Map<string, ServerRef>([[LOCAL_SERVER_ID, { id: LOCAL_SERVER_ID, name: LOCAL_SERVER_NAME }]]);
  for (const server of savedServers) if (server.id !== LOCAL_SERVER_ID) servers.set(server.id, server);
  for (const model of models) {
    const provider = modelProvider(model);
    if (provider) providers.add(provider);
    const server = modelServer(model);
    if (server && !servers.has(server.id)) servers.set(server.id, server);
  }
  return {
    providers: [...providers].sort((a, b) => a.localeCompare(b)),
    servers: [...servers.values()],
    hasHosted: models.some(model => modelLocation(model) === 'hosted'),
    hasLocal: models.some(model => modelLocation(model) === 'local'),
  };
}

/** Which filter rows the picker draws; each row is left out when it has nothing to choose between. */
export function visibleControls(
  filters: ModelPickerFilters,
  options: FilterOptions
): { location: boolean; providers: boolean; servers: boolean } {
  return {
    location: options.hasHosted && (options.hasLocal || options.servers.length > 1),
    providers: filters.location !== 'local' && options.providers.length > 1,
    servers: filters.location !== 'hosted' && options.servers.length > 1,
  };
}

/**
 * The filters as they apply to this list. A filter whose control is not drawn never applies, so a
 * remembered choice the list no longer offers (signed out, a server removed, Ollama stopped) cannot
 * hide models with no visible way to undo it. Storage keeps the remembered choice.
 */
export function effectiveFilters(filters: ModelPickerFilters, options: FilterOptions): ModelPickerFilters {
  const sideHasModels =
    filters.location === 'all' || (filters.location === 'hosted' ? options.hasHosted : options.hasLocal);
  const location = visibleControls(filters, options).location && sideHasModels ? filters.location : ('all' as const);
  const shown = visibleControls({ ...filters, location }, options);
  return {
    location,
    provider:
      shown.providers && filters.provider && options.providers.includes(filters.provider) ? filters.provider : null,
    server:
      shown.servers && filters.server && options.servers.some(server => server.id === filters.server)
        ? filters.server
        : null,
  };
}

/** A provider only exists among hosted models and a server only among local ones, so each choice clears the other. */
export function changeFilters(filters: ModelPickerFilters, change: Partial<ModelPickerFilters>): ModelPickerFilters {
  const next = { ...filters, ...change };
  if (change.location === 'all') next.provider = next.server = null;
  if (change.provider) next.server = null;
  if (change.server) next.provider = null;
  if (next.location === 'local') next.provider = null;
  if (next.location === 'hosted') next.server = null;
  return next;
}

export function matchesFilters(model: ChatModelOption, filters: ModelPickerFilters): boolean {
  if (filters.location !== 'all' && modelLocation(model) !== filters.location) return false;
  if (filters.provider && modelProvider(model) !== filters.provider) return false;
  if (filters.server && modelServer(model)?.id !== filters.server) return false;
  return true;
}

export function filtersActive(filters: ModelPickerFilters): boolean {
  return filters.location !== 'all' || !!filters.provider || !!filters.server;
}

/**
 * Whether a typed query finds a row: the whole query inside one of the row's texts, or every word
 * of it starting a word somewhere in them ("haiku bedrock", "qwen gpu"). The texts are what the row
 * shows plus its provider, its server and "hosted" or "local"; never the hidden model id.
 */
export function matchesQuery(model: ChatModelOption, query: string, detail?: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const texts = [model.name, detail, modelProvider(model), modelServer(model)?.name, modelLocation(model)]
    .filter((text): text is string => !!text)
    .map(text => text.toLowerCase());
  if (texts.some(text => text.includes(needle))) return true;
  const words = texts.flatMap(text => text.split(/[\s\-_/:.,()]+/)).filter(Boolean);
  return needle.split(/\s+/).every(token => words.some(word => word.startsWith(token)));
}

/**
 * Whether picking `target` should first be confirmed: the conversation has run on a local or
 * self-hosted model, and the next message on a hosted one sends all of it to Bike4Mind.
 */
export function needsHostedSwitchConfirm(
  currentModelId: string | null,
  target: Pick<ChatModelOption, 'id'>,
  hasHistory: boolean
): boolean {
  if (!hasHistory || !currentModelId || !parseLocalModelId(currentModelId)) return false;
  return modelLocation(target) === 'hosted';
}

/** Per-machine UI chrome, so localStorage, like the session panel's flags (sessionPanelState.ts). */
const FILTERS_KEY = 'b4m.modelPicker.filters';

function isLocationFilter(value: unknown): value is LocationFilter {
  return value === 'all' || value === 'hosted' || value === 'local';
}

export function readModelPickerFilters(): ModelPickerFilters {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(FILTERS_KEY) ?? 'null');
    if (!parsed || typeof parsed !== 'object') return NO_FILTERS;
    const { location, provider, server } = parsed as Record<string, unknown>;
    const storedProvider = typeof provider === 'string' && provider ? provider : null;
    return changeFilters(
      {
        location: isLocationFilter(location) ? location : 'all',
        provider: storedProvider,
        server: !storedProvider && typeof server === 'string' && server ? server : null,
      },
      {}
    );
  } catch {
    return NO_FILTERS;
  }
}

export function writeModelPickerFilters(filters: ModelPickerFilters): void {
  try {
    window.localStorage.setItem(FILTERS_KEY, JSON.stringify(filters));
  } catch {
    // Kept for this run; losing it on the next launch beats throwing out of a click.
  }
}

/** The remembered filters, seeded from storage and written back once a change lands. */
export function useModelPickerFilters(): [ModelPickerFilters, (next: ModelPickerFilters) => void] {
  const [filters, setFilters] = useState(readModelPickerFilters);
  const changed = useRef(false);
  useEffect(() => {
    if (changed.current) writeModelPickerFilters(filters);
  }, [filters]);
  const update = useCallback((next: ModelPickerFilters) => {
    changed.current = true;
    setFilters(next);
  }, []);
  return [filters, update];
}
