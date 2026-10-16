import { describe, expect, it } from 'vitest';
import { settingsMap, userReadableSettingKeys } from '../schemas/settings';
import {
  INTEGRATION_IDS,
  INTEGRATIONS,
  MODEL_PROVIDER_IDS,
  MODEL_PROVIDERS,
  PLANNED_INTEGRATION_IDS,
  isPlannedIntegrationId,
} from './catalog';
import { INTEGRATION_CATEGORIES, INTEGRATION_LOGO_KEYS } from './types';

const settingKeys = new Set(Object.keys(settingsMap));

describe('integrations catalog invariants', () => {
  it('has unique entry, capability and model provider ids', () => {
    expect(new Set(INTEGRATION_IDS).size).toBe(INTEGRATION_IDS.length);
    expect(new Set(MODEL_PROVIDER_IDS).size).toBe(MODEL_PROVIDER_IDS.length);
    const capabilityIds = INTEGRATIONS.flatMap(i => i.capabilities.map(c => c.id));
    expect(new Set(capabilityIds).size).toBe(capabilityIds.length);
  });

  it('names a real setting for every entry and capability flag', () => {
    const flags = INTEGRATIONS.flatMap(i => [i.flag, ...i.capabilities.map(c => c.flag)]).filter(Boolean);
    expect(flags.length).toBeGreaterThan(0);
    for (const flag of flags) expect(settingKeys.has(flag as string)).toBe(true);
  });

  it('makes every gating flag, and every parent it dependsOn, readable by a non-admin client', () => {
    // A flag the client cannot read resolves to its compiled default for non-admins, which
    // would show them a status that disagrees with the server.
    const readable = new Set(userReadableSettingKeys());
    const parentOf = (key: string) => (settingsMap as Record<string, { dependsOn?: string }>)[key]?.dependsOn;
    for (const i of INTEGRATIONS) {
      for (const flag of [i.flag, ...i.capabilities.map(c => c.flag)]) {
        for (let key: string | undefined = flag; key; key = parentOf(key)) expect(readable).toContain(key);
      }
    }
  });

  it('gives no planned entry a ga capability', () => {
    for (const i of INTEGRATIONS.filter(entry => entry.stage === 'planned')) {
      expect(i.capabilities.filter(c => c.stage === 'ga')).toEqual([]);
    }
  });

  it('gives every live entry at least one capability, none of them planned', () => {
    for (const i of INTEGRATIONS.filter(entry => entry.stage !== 'planned')) {
      expect(i.capabilities.length).toBeGreaterThan(0);
      expect(i.capabilities.filter(c => c.stage === 'planned')).toEqual([]);
    }
  });

  it('gives a ga entry at least one ga capability and a beta entry none', () => {
    for (const i of INTEGRATIONS) {
      if (i.stage === 'ga') expect(i.capabilities.some(c => c.stage === 'ga')).toBe(true);
      if (i.stage === 'beta') expect(i.capabilities.some(c => c.stage === 'ga')).toBe(false);
    }
  });

  it('uses only known categories and logo keys', () => {
    const logos = new Set<string>(INTEGRATION_LOGO_KEYS);
    for (const i of INTEGRATIONS) {
      expect(INTEGRATION_CATEGORIES).toContain(i.category);
      expect(logos.has(i.logo)).toBe(true);
    }
    for (const m of MODEL_PROVIDERS) expect(logos.has(m.logo)).toBe(true);
  });

  it('lists the planned ids, and only those are requestable', () => {
    expect(PLANNED_INTEGRATION_IDS.length).toBe(18);
    for (const id of PLANNED_INTEGRATION_IDS) expect(isPlannedIntegrationId(id)).toBe(true);
    expect(isPlannedIntegrationId('github')).toBe(false);
    expect(isPlannedIntegrationId('not-an-integration')).toBe(false);
    expect(isPlannedIntegrationId('__proto__')).toBe(false);
  });
});
