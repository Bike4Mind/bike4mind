import { act, fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import QuestMasterUpgradePrompt from './QuestMasterUpgradePrompt';
import { useQuestMasterUpgrade } from './questMasterUpgrade';

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
  beforeEach(() => useQuestMasterUpgrade.getState().close());

  it('opens on demand and routes the upgrade action to plans', () => {
    const onUpgrade = renderPrompt();
    expect(screen.queryByTestId('questmaster-upgrade-prompt')).not.toBeInTheDocument();

    act(() => useQuestMasterUpgrade.getState().open());
    expect(screen.getByTestId('questmaster-upgrade-prompt')).toHaveTextContent(
      'Questmaster is included with every paid plan.'
    );
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
});
