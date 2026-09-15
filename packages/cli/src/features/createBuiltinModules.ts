import type { ICliFeatureModule } from './ICliFeatureModule.js';
import type { CliConfig } from '../storage/types.js';
import type { ApiClient } from '../auth/ApiClient.js';
import type { HearthSession } from './hearth/types.js';
import { TavernModule } from './tavern/index.js';
import { HearthModule } from './hearth/index.js';
import { useCliStore } from '../store/index.js';

/**
 * Current CLI session as Hearth's per-session identity, or undefined before one
 * exists. `label` is the notebook name, which the server renders but never uses
 * as the actor identity key - it is renameable and auto-titled.
 *
 * `kind: 'agent'` because every hearth_* write is an LLM tool call - there is no
 * path by which a human types directly into the log from here - so leaving the
 * kind to default made the account's agent traffic badge as Human, which is the
 * one distinction a reader of a busy channel most needs. The NAME is still
 * server-derived from the account, so this only sharpens the badge; it claims
 * nothing about who owns the session.
 */
export function hearthSessionFromStore(): HearthSession | undefined {
  const session = useCliStore.getState().session;
  return session ? { id: session.id, label: session.name, kind: 'agent' } : undefined;
}

/**
 * Construct the config-enabled built-in feature modules. Built-ins keep their
 * ad-hoc constructors (Tavern binds the global CLI store) and do not go
 * through the external-plugin factory path; they are registered ahead of
 * plugins so a plugin can never claim a built-in name. Used by both the
 * bootstrap and hot-reload sites in index.tsx - keep the construction here so
 * the two stay identical.
 */
export function createBuiltinModules(config: CliConfig, apiClient: ApiClient): ICliFeatureModule[] {
  const modules: ICliFeatureModule[] = [];
  if (config.features?.tavern) {
    modules.push(
      new TavernModule(
        apiClient,
        entry => useCliStore.getState().addTavernLogEntry(entry),
        () => useCliStore.getState().tavernActivityLog
      )
    );
  }
  if (config.features?.hearth) {
    // Read the session through the store on every call rather than capturing it:
    // this factory also runs on config hot-reload, and a fresh session can start
    // mid-process. A captured id would go stale and silently collapse the
    // session back onto the account-wide actor, which shares one cursor.
    modules.push(new HearthModule(apiClient, () => hearthSessionFromStore()));
  }
  return modules;
}
