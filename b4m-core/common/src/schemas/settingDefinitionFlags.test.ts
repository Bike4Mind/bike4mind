import { afterEach, describe, expect, it } from 'vitest';
import {
  allSettingDefinitions,
  makeContributedBooleanSetting,
  registerContributedSettings,
  resetContributedSettings,
  resolveSettingDefinition,
  settingsMap,
} from './settings';

afterEach(() => resetContributedSettings());

describe('hideFromSettingsList', () => {
  // Pinned, not derived: a setting joining or leaving the Admin Settings list has to be a deliberate edit here.
  it('is set on exactly the core settings with their own editor or no editor at all', () => {
    const hidden = Object.values(settingsMap)
      .filter(definition => definition.hideFromSettingsList)
      .map(definition => definition.key)
      .sort();
    expect(hidden).toEqual(
      [
        'EnableContextTelemetry',
        'RapidReplySettings',
        'SystemFiles',
        'contextTelemetryAlerts',
        'logoSettings',
        'modelAccessRevision',
        'modelListRevision',
        'overwatchRollupSync',
        'prReportEgressAllowlist',
        'prReportIdentityMap',
        'prReportRepo',
        'prReportWebhookUrl',
        'releaseNotesConfig',
        'secopsTriageConfig',
        'sreAgentConfig',
      ].sort()
    );
  });

  it('is carried by a contributed definition', () => {
    registerContributedSettings([
      makeContributedBooleanSetting({
        key: 'ExtensionOwnEditor',
        name: 'Extension own editor',
        description: 'x',
        defaultValue: false,
        hideFromSettingsList: true,
      }),
    ]);
    expect(resolveSettingDefinition('ExtensionOwnEditor')?.hideFromSettingsList).toBe(true);
  });
});

describe('modelReferences', () => {
  it('lists the model of each enabled item under its path, for the core setting that declares it', () => {
    const declaring = allSettingDefinitions().filter(definition => definition.modelReferences);
    expect(declaring.map(definition => definition.key)).toEqual(['sreAgentConfig']);

    const value = settingsMap.sreAgentConfig.schema.parse({
      repos: [
        { owner: 'o', repo: 'paused', enabled: false, modelId: 'model-a' },
        { owner: 'o', repo: 'live', enabled: true, modelId: 'model-b' },
      ],
    });
    expect(declaring[0].modelReferences?.(value)).toEqual({ 'repos.1.modelId': 'model-b' });
  });

  it('lists nothing for the default value', () => {
    const { defaultValue, modelReferences } = settingsMap.sreAgentConfig;
    expect(modelReferences?.(defaultValue)).toEqual({});
  });

  it('is carried by a contributed definition', () => {
    const definition = {
      ...makeContributedBooleanSetting({
        key: 'ExtensionPinnedModel',
        name: 'Extension pinned model',
        description: 'x',
        defaultValue: false,
      }),
      modelReferences: () => ({ model: 'model-c' }),
    };
    registerContributedSettings([definition]);
    expect(resolveSettingDefinition('ExtensionPinnedModel')?.modelReferences?.(true)).toEqual({ model: 'model-c' });
  });
});
