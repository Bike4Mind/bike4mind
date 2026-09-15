import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { settingsMap, type IAdminSettings, type IScopedSetting } from '@bike4mind/common';

const clearMutate = vi.fn();
// Read at render time so a test can stage the inventory and the platform values.
let overrides: IScopedSetting[] = [];
let platformSettings: IAdminSettings[] = [];

vi.mock('@client/app/hooks/data/settings', () => ({
  useScopedSettingOverrides: () => ({ data: overrides }),
  useSettingsFromServer: () => ({ data: platformSettings }),
  useClearScopedSettingOverride: () => ({ mutate: clearMutate, isPending: false, error: undefined }),
}));

import { ScopedOverridesByScope } from './ScopedOverridesByScope';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderPanel = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <ScopedOverridesByScope />
    </CssVarsProvider>
  );

const scopeCapableKeys = Object.values(settingsMap)
  .filter(s => s.scope)
  .map(s => s.key);

const enterAddress = (id: string) =>
  fireEvent.change(screen.getByTestId('scoped-overrides-by-scope-id-input'), { target: { value: id } });

describe('ScopedOverridesByScope', () => {
  beforeEach(() => {
    overrides = [];
    platformSettings = [];
    vi.clearAllMocks();
  });

  it('asks for a scope id before reporting anything', () => {
    renderPanel();
    expect(screen.getByTestId('scoped-overrides-by-scope-prompt')).toBeInTheDocument();
    expect(screen.queryByTestId(`scoped-overrides-by-scope-row-${scopeCapableKeys[0]}`)).not.toBeInTheDocument();
  });

  it('lists every scope-capable setting for the address, and only those', () => {
    renderPanel();
    enterAddress('org-1');

    // Nine today; asserted against the derived set so a setting opting into scoping later is
    // covered without editing this test.
    expect(scopeCapableKeys.length).toBeGreaterThan(0);
    for (const key of scopeCapableKeys) {
      expect(screen.getByTestId(`scoped-overrides-by-scope-row-${key}`)).toBeInTheDocument();
    }
    // A platform-only setting is not part of this view.
    expect(screen.queryByTestId('scoped-overrides-by-scope-row-DefaultAPIModel')).not.toBeInTheDocument();
  });

  it('splits the list into overridden here, no override at this rung, and not settable here', () => {
    overrides = [
      {
        settingName: 'kbSearchDefaultResults',
        scopeLevel: 'organization',
        scopeId: 'org-1',
        settingValue: '7',
      } as IScopedSetting,
      // Same setting, a different address - must not be read as this scope's override.
      {
        settingName: 'kbSearchMinRelevancePct',
        scopeLevel: 'organization',
        scopeId: 'org-2',
        settingValue: '40',
      } as IScopedSetting,
    ];
    platformSettings = [{ settingName: 'kbSearchMinRelevancePct', settingValue: '10' } as IAdminSettings];
    renderPanel();
    enterAddress('org-1');

    expect(screen.getByTestId('scoped-overrides-by-scope-row-kbSearchDefaultResults')).toHaveTextContent(
      'overridden here: 7'
    );
    expect(screen.getByTestId('scoped-overrides-by-scope-row-kbSearchMinRelevancePct')).toHaveTextContent(
      'no override at this rung (platform: 10)'
    );
    // No stored platform row: the setting's own default is the platform value.
    expect(screen.getByTestId('scoped-overrides-by-scope-row-dataLakeSearchMaxFiles')).toHaveTextContent(
      `no override at this rung (platform: ${String(settingsMap.dataLakeSearchMaxFiles.defaultValue)})`
    );
  });

  // DefaultChunkSize is settableAt organization/owner only, so at the lake rung an override can
  // never exist there - saying "no override" would read as if one could be set.
  it('names a rung the setting cannot be set at, rather than calling it un-overridden', () => {
    renderPanel();
    fireEvent.click(screen.getByTestId('scoped-overrides-by-scope-level-select'));
    fireEvent.click(screen.getByTestId('scoped-overrides-by-scope-level-option-lake'));
    enterAddress('lake-1');

    expect(screen.getByTestId('scoped-overrides-by-scope-row-DefaultChunkSize')).toHaveTextContent(
      'not settable at this rung'
    );
    expect(screen.getByTestId('scoped-overrides-by-scope-row-PauseLakeConvergence')).toHaveTextContent(
      'no override at this rung'
    );
  });

  // #2624 removed the Lake rung from the data-lake scan budgets. A row saved there before that is
  // still in the collection and is no longer resolved, so calling it "overridden here" would show
  // the operator a value that nothing reads.
  it('reports a stored override at a rung the setting lost as inert, and still offers Clear', () => {
    overrides = [
      {
        settingName: 'dataLakeSearchMaxFiles',
        scopeLevel: 'lake',
        scopeId: 'lake-1',
        settingValue: '1',
      } as IScopedSetting,
    ];
    renderPanel();
    fireEvent.click(screen.getByTestId('scoped-overrides-by-scope-level-select'));
    fireEvent.click(screen.getByTestId('scoped-overrides-by-scope-level-option-lake'));
    enterAddress('lake-1');

    const inertRow = screen.getByTestId('scoped-overrides-by-scope-row-dataLakeSearchMaxFiles');
    expect(inertRow).toHaveTextContent('1 is stored here, but it is inert');
    expect(inertRow).not.toHaveTextContent('overridden here');
    expect(screen.getByTestId('scoped-overrides-by-scope-clear-btn-dataLakeSearchMaxFiles')).toBeInTheDocument();
  });

  it('clears the override at the address it is listed under', () => {
    overrides = [
      {
        settingName: 'PauseLakeConvergence',
        scopeLevel: 'lake',
        scopeId: 'lake-1',
        settingValue: 'true',
      } as IScopedSetting,
    ];
    renderPanel();
    fireEvent.click(screen.getByTestId('scoped-overrides-by-scope-level-select'));
    fireEvent.click(screen.getByTestId('scoped-overrides-by-scope-level-option-lake'));
    enterAddress('lake-1');

    // Only the overridden row offers a Clear.
    expect(screen.queryByTestId('scoped-overrides-by-scope-clear-btn-DefaultChunkSize')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('scoped-overrides-by-scope-clear-btn-PauseLakeConvergence'));
    expect(clearMutate).toHaveBeenCalledWith({
      settingName: 'PauseLakeConvergence',
      scopeLevel: 'lake',
      scopeId: 'lake-1',
    });
  });

  it('discloses the propagation delay', () => {
    renderPanel();
    expect(screen.getByTestId('scoped-overrides-by-scope')).toHaveTextContent(
      'within ~5 min (one cache TTL) everywhere else'
    );
  });
});
