import type { ICliFeatureModule } from './ICliFeatureModule.js';
import type { CliConfig } from '../storage/types.js';
import type { ApiClient } from '../auth/ApiClient.js';
import { TavernModule } from './tavern/index.js';
import { useCliStore } from '../store/index.js';

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
  return modules;
}
