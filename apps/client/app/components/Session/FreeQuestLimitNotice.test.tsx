import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { beforeEach, describe, expect, it } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import { useQuestMasterUpgrade } from '@client/app/components/subscription/questMasterUpgrade';
import { FreeQuestLimitNotice } from './FreeQuestLimitNotice';

const theme = extendTheme({ ...getThemeConfig() });

describe('FreeQuestLimitNotice', () => {
  beforeEach(() => useQuestMasterUpgrade.getState().close());

  it('shows the server message and opens the upgrade prompt from See options', () => {
    render(
      <CssVarsProvider theme={theme}>
        <FreeQuestLimitNotice message="Free quest used." />
      </CssVarsProvider>
    );
    expect(screen.getByTestId('free-quest-limit-message')).toHaveTextContent('Free quest used.');
    expect(useQuestMasterUpgrade.getState().isOpen).toBe(false);
    fireEvent.click(screen.getByTestId('free-quest-limit-options-btn'));
    expect(useQuestMasterUpgrade.getState().isOpen).toBe(true);
  });
});
