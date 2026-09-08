import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { settingsMap, type IScopedSetting } from '@bike4mind/common';

const setMutate = vi.fn();
const clearMutate = vi.fn();
// Read at render time so a test can stage the inventory the section renders from, or put a
// mutation into its rejected state.
let overrides: IScopedSetting[] = [];
let setError: unknown;

vi.mock('@client/app/hooks/data/settings', () => ({
  useScopedSettingOverrides: () => ({ data: overrides }),
  useSetScopedSettingOverride: () => ({ mutate: setMutate, isPending: false, error: setError }),
  useClearScopedSettingOverride: () => ({ mutate: clearMutate, isPending: false, error: undefined }),
}));

import ScopedSettingOverrides from './ScopedSettingOverrides';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

// PauseLakeConvergence is boolean and settable at all three rungs; kbSearchDefaultResults is a
// bounded number settable at organization/owner only. Between them they cover every branch of the
// value control and of the level options.
const renderSection = (setting: (typeof settingsMap)[keyof typeof settingsMap]) =>
  render(
    <TestWrapper>
      <ScopedSettingOverrides setting={setting} />
    </TestWrapper>
  );

const row = (over: Partial<IScopedSetting>): IScopedSetting =>
  ({
    settingName: 'PauseLakeConvergence',
    scopeLevel: 'lake',
    scopeId: 'lake-1',
    settingValue: 'true',
    ...over,
  }) as IScopedSetting;

/** Open a Joy Select and pick one of its options by testid. */
const chooseOption = (selectTestId: string, optionTestId: string) => {
  fireEvent.click(screen.getByTestId(selectTestId));
  fireEvent.click(screen.getByTestId(optionTestId));
};

describe('ScopedSettingOverrides level options', () => {
  beforeEach(() => {
    overrides = [];
    setError = undefined;
    vi.clearAllMocks();
  });

  it('offers exactly the rungs the setting is settableAt', () => {
    renderSection(settingsMap.PauseLakeConvergence);
    fireEvent.click(screen.getByTestId('scoped-override-PauseLakeConvergence-level-select'));

    expect(screen.getAllByRole('option').map(o => o.textContent)).toEqual(['Organization', 'Owner', 'Lake']);
  });

  it('omits the lake rung for a setting that is not settable there', () => {
    renderSection(settingsMap.kbSearchDefaultResults);
    fireEvent.click(screen.getByTestId('scoped-override-kbSearchDefaultResults-level-select'));

    expect(screen.getAllByRole('option').map(o => o.textContent)).toEqual(['Organization', 'Owner']);
  });

  it('renders nothing for a setting that does not opt into scoping', () => {
    renderSection(settingsMap.DefaultAPIModel);
    expect(screen.queryByTestId('scoped-override-DefaultAPIModel-header')).not.toBeInTheDocument();
  });
});

describe('ScopedSettingOverrides owner type', () => {
  beforeEach(() => {
    overrides = [];
    setError = undefined;
    vi.clearAllMocks();
  });

  it('asks for an owner type only at the owner rung, and sends it only there', () => {
    renderSection(settingsMap.PauseLakeConvergence);
    // Lake is not the initial selection, so the absence below is not vacuous.
    expect(screen.queryByTestId('scoped-override-PauseLakeConvergence-owner-type-select')).not.toBeInTheDocument();

    chooseOption(
      'scoped-override-PauseLakeConvergence-level-select',
      'scoped-override-PauseLakeConvergence-level-option-owner'
    );
    expect(screen.getByTestId('scoped-override-PauseLakeConvergence-owner-type-select')).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('scoped-override-PauseLakeConvergence-scope-id-input'), {
      target: { value: 'user-1' },
    });
    fireEvent.click(screen.getByTestId('scoped-override-PauseLakeConvergence-value-switch'));
    fireEvent.click(screen.getByTestId('scoped-override-PauseLakeConvergence-set-btn'));

    expect(setMutate).toHaveBeenCalledWith({
      settingName: 'PauseLakeConvergence',
      scopeLevel: 'owner',
      scopeId: 'user-1',
      ownerType: 'User',
      value: true,
    });
  });

  it('leaves ownerType off a lake-rung write - the service refuses it anywhere but owner', () => {
    renderSection(settingsMap.PauseLakeConvergence);
    chooseOption(
      'scoped-override-PauseLakeConvergence-level-select',
      'scoped-override-PauseLakeConvergence-level-option-lake'
    );
    fireEvent.change(screen.getByTestId('scoped-override-PauseLakeConvergence-scope-id-input'), {
      target: { value: 'lake-9' },
    });
    fireEvent.click(screen.getByTestId('scoped-override-PauseLakeConvergence-set-btn'));

    expect(setMutate).toHaveBeenCalledWith({
      settingName: 'PauseLakeConvergence',
      scopeLevel: 'lake',
      scopeId: 'lake-9',
      value: false,
    });
  });
});

describe('ScopedSettingOverrides number values', () => {
  beforeEach(() => {
    overrides = [];
    setError = undefined;
    vi.clearAllMocks();
  });

  it('sends a number, not a string, once the field holds a value in range', () => {
    renderSection(settingsMap.kbSearchDefaultResults);
    fireEvent.change(screen.getByTestId('scoped-override-kbSearchDefaultResults-scope-id-input'), {
      target: { value: 'org-1' },
    });
    fireEvent.change(screen.getByTestId('scoped-override-kbSearchDefaultResults-value-input'), {
      target: { value: '7' },
    });
    fireEvent.click(screen.getByTestId('scoped-override-kbSearchDefaultResults-set-btn'));

    expect(setMutate).toHaveBeenCalledWith({
      settingName: 'kbSearchDefaultResults',
      scopeLevel: 'organization',
      scopeId: 'org-1',
      value: 7,
    });
  });

  it('blocks Set on an out-of-range number and says why', () => {
    renderSection(settingsMap.kbSearchDefaultResults);
    fireEvent.change(screen.getByTestId('scoped-override-kbSearchDefaultResults-scope-id-input'), {
      target: { value: 'org-1' },
    });
    fireEvent.change(screen.getByTestId('scoped-override-kbSearchDefaultResults-value-input'), {
      target: { value: '500' },
    });

    expect(screen.getByTestId('scoped-override-kbSearchDefaultResults-set-btn')).toBeDisabled();
    expect(screen.getByTestId('scoped-override-kbSearchDefaultResults-helper')).toHaveTextContent(
      'Enter a number between 1 and 10.'
    );

    fireEvent.click(screen.getByTestId('scoped-override-kbSearchDefaultResults-set-btn'));
    expect(setMutate).not.toHaveBeenCalled();
  });

  // Number('') is 0, which kbSearchResultTokenBudget (min: 0) would accept as a real zero.
  it('blocks Set while the number field is empty', () => {
    renderSection(settingsMap.kbSearchResultTokenBudget);
    fireEvent.change(screen.getByTestId('scoped-override-kbSearchResultTokenBudget-scope-id-input'), {
      target: { value: 'org-1' },
    });

    expect(screen.getByTestId('scoped-override-kbSearchResultTokenBudget-set-btn')).toBeDisabled();
  });

  it('blocks Set until a scope id is entered', () => {
    renderSection(settingsMap.PauseLakeConvergence);
    expect(screen.getByTestId('scoped-override-PauseLakeConvergence-set-btn')).toBeDisabled();

    fireEvent.change(screen.getByTestId('scoped-override-PauseLakeConvergence-scope-id-input'), {
      target: { value: '  ' },
    });
    expect(screen.getByTestId('scoped-override-PauseLakeConvergence-set-btn')).toBeDisabled();
  });
});

describe('ScopedSettingOverrides existing rows', () => {
  beforeEach(() => {
    overrides = [];
    setError = undefined;
    vi.clearAllMocks();
  });

  it('lists only this setting overrides, with the stored value and a working Clear', () => {
    overrides = [
      row({ scopeLevel: 'lake', scopeId: 'lake-1', settingValue: 'true' }),
      row({ scopeLevel: 'owner', scopeId: 'user-2', ownerType: 'User', settingValue: 'false' }),
      row({ settingName: 'kbSearchDefaultResults', scopeLevel: 'organization', scopeId: 'org-3', settingValue: '7' }),
    ];
    renderSection(settingsMap.PauseLakeConvergence);

    expect(screen.getByTestId('scoped-override-PauseLakeConvergence-header')).toHaveTextContent('Scoped overrides (2)');
    expect(screen.getByTestId('scoped-override-PauseLakeConvergence-row-lake-lake-1')).toHaveTextContent(
      'Lake lake-1 = On'
    );
    expect(screen.getByTestId('scoped-override-PauseLakeConvergence-row-owner-user-2')).toHaveTextContent(
      'Owner user-2 (User) = Off'
    );
    // The kbSearchDefaultResults row belongs to another setting section.
    expect(screen.queryByTestId('scoped-override-PauseLakeConvergence-row-organization-org-3')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('scoped-override-PauseLakeConvergence-clear-btn-lake-lake-1'));
    expect(clearMutate).toHaveBeenCalledWith({
      settingName: 'PauseLakeConvergence',
      scopeLevel: 'lake',
      scopeId: 'lake-1',
    });
  });

  it('says so when nothing is overridden, and discloses the propagation delay', () => {
    renderSection(settingsMap.PauseLakeConvergence);

    expect(screen.getByTestId('scoped-override-PauseLakeConvergence-empty')).toBeInTheDocument();
    expect(screen.getByTestId('scoped-override-PauseLakeConvergence-helper')).toHaveTextContent(
      'within ~5 min (one cache TTL) everywhere else'
    );
  });

  // A refused write is otherwise silent - the button just stops spinning. The server's message is
  // the only thing that names which rule was broken (the route preserves the service's wording).
  it('surfaces a refused write', () => {
    setError = new Error("[scopedSettings] 'PauseLakeConvergence' is not settable at scope level 'owner'");
    renderSection(settingsMap.PauseLakeConvergence);

    expect(screen.getByTestId('scoped-override-PauseLakeConvergence-error')).toHaveTextContent(
      'is not settable at scope level'
    );
  });
});
