import { act, fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import QuestMasterUpgradePrompt from './QuestMasterUpgradePrompt';
import { useQuestMasterUpgrade } from './questMasterUpgrade';

const mocks = vi.hoisted(() => ({ setLLM: vi.fn() }));
vi.mock('@client/app/contexts/LLMContext', () => ({
  useLLM: (selector: (s: { setLLM: typeof mocks.setLLM }) => unknown) => selector({ setLLM: mocks.setLLM }),
}));

const theme = extendTheme({ ...getThemeConfig() });
const renderPrompt = (onUpgrade = vi.fn()) => {
  render(
    <CssVarsProvider theme={theme}>
      <QuestMasterUpgradePrompt onUpgrade={onUpgrade} />
    </CssVarsProvider>
  );
  return onUpgrade;
};

describe('QuestMasterUpgradePrompt', () => {
  beforeEach(() => {
    mocks.setLLM.mockClear();
    useQuestMasterUpgrade.getState().close();
  });

  it('opens on demand and routes the upgrade action to plans', () => {
    const onUpgrade = renderPrompt();
    expect(screen.queryByTestId('questmaster-upgrade-prompt')).not.toBeInTheDocument();

    act(() => useQuestMasterUpgrade.getState().open());
    expect(screen.getByTestId('questmaster-upgrade-prompt')).toHaveTextContent(
      'Questmaster is included with every paid plan'
    );
    expect(screen.getByTestId('questmaster-upgrade-prompt')).toHaveTextContent('requires an active subscription');
    expect(screen.getByTestId('questmaster-upgrade-prompt')).toHaveTextContent('read and export existing quests');
    expect(screen.getByTestId('questmaster-upgrade-prompt')).not.toHaveTextContent('You have used your free');
    fireEvent.click(screen.getByTestId('questmaster-upgrade-plans-btn'));
    expect(onUpgrade).toHaveBeenCalledOnce();
    expect(screen.queryByTestId('questmaster-upgrade-prompt')).not.toBeInTheDocument();
  });

  it.each(['cancel', 'close'])('dismisses with %s without opening plans', action => {
    useQuestMasterUpgrade.getState().open();
    const onUpgrade = renderPrompt();
    fireEvent.click(screen.getByTestId(`questmaster-upgrade-${action}-btn`));
    expect(onUpgrade).not.toHaveBeenCalled();
    expect(screen.queryByTestId('questmaster-upgrade-prompt')).not.toBeInTheDocument();
  });

  it('keeps the explanation without an upgrade action when billing is unavailable', () => {
    useQuestMasterUpgrade.getState().open();
    render(
      <CssVarsProvider theme={theme}>
        <QuestMasterUpgradePrompt />
      </CssVarsProvider>
    );
    expect(screen.getByTestId('questmaster-upgrade-prompt')).toBeInTheDocument();
    expect(screen.queryByTestId('questmaster-upgrade-plans-btn')).not.toBeInTheDocument();
    expect(screen.getByTestId('questmaster-upgrade-prompt')).toHaveTextContent('Ask your administrator');
    expect(screen.getByTestId('questmaster-upgrade-prompt')).toHaveTextContent(
      'Questmaster is included with every paid plan'
    );
    expect(screen.getByTestId('questmaster-upgrade-prompt')).toHaveTextContent('read and export existing quests');
    expect(screen.getByTestId('questmaster-upgrade-disable-btn')).toBeInTheDocument();
  });

  it('turns Questmaster off and closes without opening plans', () => {
    useQuestMasterUpgrade.getState().open();
    const onUpgrade = renderPrompt();
    fireEvent.click(screen.getByTestId('questmaster-upgrade-disable-btn'));
    expect(mocks.setLLM).toHaveBeenCalledWith({ isQuestMasterEnabled: false });
    expect(onUpgrade).not.toHaveBeenCalled();
    expect(screen.queryByTestId('questmaster-upgrade-prompt')).not.toBeInTheDocument();
  });
});
