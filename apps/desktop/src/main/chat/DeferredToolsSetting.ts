import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import { settingsMap } from '@bike4mind/common';

/** What ChatService reads per turn: absent is off, present is on with this start-set limit. */
export interface DeferredToolsConfig {
  startSetMaxTokens: number;
}

interface ServerValue {
  enabled: boolean;
  startSetMaxTokens: number;
}

/** Non-admins read these through `userReadable` on their definitions in @bike4mind/common settings.ts. */
const SETTINGS_PATH = '/api/settings/fetch';
const ENABLED_KEY = 'EnableDeferredToolLoading';
const START_KEY = 'DeferredToolStartSetMaxTokens';
const DEFAULT_START_SET_MAX_TOKENS = settingsMap[START_KEY].defaultValue ?? 100_000;

/** How long a server answer is trusted before the next turn asks again (ms). */
const FRESH_MS = 10 * 60_000;

/**
 * The local overrides: B4M_DESKTOP_DEFERRED_TOOLS `0` forces deferral off and `1` forces it on;
 * anything else follows the server. B4M_DESKTOP_DEFERRED_START_MAX_TOKENS, a non-negative number,
 * replaces the server's start-set limit.
 */
export function parseDeferredToolsOverride(
  enabled: string | undefined,
  startMaxTokens: string | undefined
): { enabled?: boolean; startSetMaxTokens?: number } {
  const flag = enabled?.trim();
  const raw = startMaxTokens?.trim();
  const limit = raw ? Number(raw) : NaN;
  return {
    ...(flag === '0' ? { enabled: false } : flag === '1' ? { enabled: true } : {}),
    ...(Number.isFinite(limit) && limit >= 0 ? { startSetMaxTokens: limit } : {}),
  };
}

/** The server's answer from the user-readable settings rows; a missing row is the setting's default. */
export function readServerValue(rows: unknown): ServerValue | undefined {
  if (!Array.isArray(rows)) return undefined;
  const stored = (key: string): unknown =>
    (rows as { settingName?: unknown; settingValue?: unknown }[]).find(row => row?.settingName === key)?.settingValue;
  const enabled = settingsMap[ENABLED_KEY].schema.safeParse(stored(ENABLED_KEY));
  const limit = settingsMap[START_KEY].schema.safeParse(stored(START_KEY));
  return {
    enabled: enabled.success ? enabled.data === true : settingsMap[ENABLED_KEY].defaultValue === true,
    startSetMaxTokens:
      limit.success && typeof limit.data === 'number' && limit.data >= 0 ? limit.data : DEFAULT_START_SET_MAX_TOKENS,
  };
}

export interface DeferredToolsSettingDeps {
  /** Last known answer per server, so a launch that cannot reach one keeps what it said. */
  filePath: string;
  getApiClient: () => AuthenticatedApiClient | null;
  getEnvironmentUrl: () => string;
  logger: { debug(message: string): void };
  override?: { enabled?: boolean; startSetMaxTokens?: number };
  now?: () => number;
}

/**
 * Deferred tool loading follows the server's EnableDeferredToolLoading admin setting. `current()`
 * answers from the last known value for this server (off when there is none) and asks the server
 * again in the background once that answer is stale, so a change applies from the next turn.
 */
export class DeferredToolsSetting {
  private known: Record<string, ServerValue> | undefined;
  private readonly checkedAt = new Map<string, number>();
  /** Shared across environments: a switch mid-refresh waits for a later turn to ask the new server. */
  private inFlight: Promise<void> | undefined;

  constructor(private readonly deps: DeferredToolsSettingDeps) {}

  current(): DeferredToolsConfig | undefined {
    const { override } = this.deps;
    if (override?.enabled === false) return undefined;
    if (override?.enabled === true)
      return { startSetMaxTokens: override.startSetMaxTokens ?? DEFAULT_START_SET_MAX_TOKENS };
    const environmentUrl = this.deps.getEnvironmentUrl();
    const checked = this.checkedAt.get(environmentUrl);
    if (checked === undefined || this.now() - checked >= FRESH_MS) void this.refresh();
    const server = this.known?.[environmentUrl];
    if (!server?.enabled) return undefined;
    return { startSetMaxTokens: override?.startSetMaxTokens ?? server.startSetMaxTokens };
  }

  /** Read the stored answers once, then ask the signed-in server. Never throws. */
  refresh(): Promise<void> {
    this.inFlight ??= this.ask().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async ask(): Promise<void> {
    this.known ??= await this.load();
    const api = this.deps.getApiClient();
    if (!api) return;
    const environmentUrl = this.deps.getEnvironmentUrl();
    this.checkedAt.set(environmentUrl, this.now());
    let value: ServerValue | undefined;
    try {
      value = readServerValue(await api.get<unknown>(SETTINGS_PATH));
    } catch (err) {
      this.deps.logger.debug(
        `CHAT: deferred tools setting lookup failed, keeping the last known value: ${
          err instanceof Error ? err.message : 'unknown'
        }`
      );
    }
    if (!value) return;
    const previous = this.known[environmentUrl];
    if (previous?.enabled === value.enabled && previous.startSetMaxTokens === value.startSetMaxTokens) return;
    this.known = { ...this.known, [environmentUrl]: value };
    try {
      await this.save(this.known);
    } catch (err) {
      this.deps.logger.debug(`CHAT: could not store the deferred tools setting: ${String(err)}`);
    }
  }

  private async load(): Promise<Record<string, ServerValue>> {
    try {
      const parsed = JSON.parse(await readFile(this.deps.filePath, 'utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object') return {};
      return Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>).flatMap(([url, entry]) => {
          const { enabled, startSetMaxTokens } = (entry ?? {}) as Partial<ServerValue>;
          return typeof enabled === 'boolean' && typeof startSetMaxTokens === 'number' && startSetMaxTokens >= 0
            ? [[url, { enabled, startSetMaxTokens }]]
            : [];
        })
      );
    } catch {
      return {};
    }
  }

  private async save(known: Record<string, ServerValue>): Promise<void> {
    await mkdir(dirname(this.deps.filePath), { recursive: true });
    const temporary = `${this.deps.filePath}.tmp`;
    await writeFile(temporary, JSON.stringify(known, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.deps.filePath);
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}
