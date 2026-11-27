/**
 * Render-completeness test for AdminSettingsTab grouping logic.
 *
 * renderSettingGroup distributes settings into topLevelSettings and
 * inlineChildrenByParent. A grandchild (dependsOn -> child that itself has
 * dependsOn -> top-level) was silently dropped because the one-level render
 * only looks up inlineChildrenByParent[topLevel], not grandchildren. This test
 * catches that class of silent-drop for the whole settings map.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  settingsMap,
  API_SERVICE_GROUPS,
  allSettingDefinitions,
  makeContributedBooleanSetting,
  registerContributedSettings,
  resetContributedSettings,
  resolveSettingDefinition,
} from '@bike4mind/common';

type SettingKey = keyof typeof settingsMap;

function simulateGrouping(settingKeys: string[]) {
  const settingKeysInGroup = new Set<string>(settingKeys);
  const inlineChildrenByParent = new Map<string, string[]>();
  const topLevelSettings: string[] = [];

  for (const key of settingKeys) {
    const meta = resolveSettingDefinition(key);
    const dep = meta?.dependsOn;
    if (dep && settingKeysInGroup.has(dep) && meta?.type === 'boolean') {
      const parentMeta = resolveSettingDefinition(dep);
      const grandparentDep = parentMeta?.dependsOn;
      const resolvedParent = grandparentDep && settingKeysInGroup.has(grandparentDep) ? grandparentDep : dep;
      const children = inlineChildrenByParent.get(resolvedParent) ?? [];
      children.push(key);
      inlineChildrenByParent.set(resolvedParent, children);
    } else {
      topLevelSettings.push(key);
    }
  }

  return { topLevelSettings, inlineChildrenByParent };
}

describe('AdminSettingsTab grouping — render completeness', () => {
  const experimentalGroupId = API_SERVICE_GROUPS.EXPERIMENTAL.id;
  const experimentalKeys = (Object.keys(settingsMap) as SettingKey[]).filter(
    k => settingsMap[k].group === experimentalGroupId
  );

  it('every setting in the experimentalService group is reachable after grouping', () => {
    const { topLevelSettings, inlineChildrenByParent } = simulateGrouping(experimentalKeys);

    // Mirror the actual render (AdminSettingsTab.tsx): only topLevelSettings render,
    // each with its OWN direct children (inlineChildrenByParent[topLevel]). A child
    // grouped under a non-top-level parent is NOT rendered - so counting all
    // inlineChildrenByParent values would give a false pass for a 4+ level chain the
    // single-hop re-parent doesn't reach. Compute reachability the way the DOM does.
    const allRendered = new Set<string>([
      ...topLevelSettings,
      ...topLevelSettings.flatMap(parent => inlineChildrenByParent.get(parent) ?? []),
    ]);

    for (const key of experimentalKeys) {
      expect(
        allRendered.has(key),
        `"${key}" is silently dropped — not top-level and not a child of any top-level`
      ).toBe(true);
    }
  });

  it('EnableFamilyCompute renders as a subSetting of EnableOptiHashi', () => {
    const { inlineChildrenByParent } = simulateGrouping(experimentalKeys);

    const canvasserChildren = inlineChildrenByParent.get('EnableOptiHashi') ?? [];
    expect(
      canvasserChildren.includes('EnableFamilyCompute'),
      'EnableFamilyCompute should be re-parented to EnableOptiHashi for rendering'
    ).toBe(true);
  });

  it('EnableComputeSubmission is still a direct subSetting of EnableOptiHashi', () => {
    const { inlineChildrenByParent } = simulateGrouping(experimentalKeys);

    const canvasserChildren = inlineChildrenByParent.get('EnableOptiHashi') ?? [];
    expect(canvasserChildren.includes('EnableComputeSubmission')).toBe(true);
  });
});

describe('AdminSettingsTab grouping - contributed settings', () => {
  afterEach(() => resetContributedSettings());

  it('nests a contributed child under its contributed parent, by each definition group', () => {
    const group = API_SERVICE_GROUPS.EXPERIMENTAL.id;
    registerContributedSettings([
      makeContributedBooleanSetting({ key: 'ExtensionParent', name: 'Parent', description: 'x', group }),
      makeContributedBooleanSetting({
        key: 'ExtensionChild',
        name: 'Child',
        description: 'x',
        group,
        dependsOn: 'ExtensionParent',
      }),
    ]);
    const groupKeys = allSettingDefinitions()
      .filter(s => s.group === group)
      .map(s => s.key);
    expect(groupKeys).toEqual(expect.arrayContaining(['ExtensionParent', 'ExtensionChild']));

    const { topLevelSettings, inlineChildrenByParent } = simulateGrouping(groupKeys);
    expect(topLevelSettings).toContain('ExtensionParent');
    expect(topLevelSettings).not.toContain('ExtensionChild');
    expect(inlineChildrenByParent.get('ExtensionParent')).toEqual(['ExtensionChild']);
  });
});
