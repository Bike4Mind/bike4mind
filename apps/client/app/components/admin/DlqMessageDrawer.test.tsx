import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { DlqMessage } from '@client/app/hooks/data/dlqManagement';
import { DlqMessageDrawer } from './DlqMessageDrawer';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));

const appTheme = extendTheme({ ...getThemeConfig() });

const renderDrawer = (message: DlqMessage) =>
  render(
    <CssVarsProvider theme={appTheme}>
      <DlqMessageDrawer message={message} open onClose={() => undefined} />
    </CssVarsProvider>
  );

describe('DlqMessageDrawer body', () => {
  it('shows the withheld note and no copy button when the body is withheld', () => {
    renderDrawer({ messageId: 'm1', body: '', bodyWithheld: true });

    expect(screen.getByTestId('dlq-body-withheld')).toBeTruthy();
    expect(screen.queryByTestId('dlq-copy-body')).toBeNull();
  });

  it('shows the body and copy button otherwise', () => {
    renderDrawer({ messageId: 'm1', body: '{"jobId":"j1"}' });

    expect(screen.queryByTestId('dlq-body-withheld')).toBeNull();
    expect(screen.getByTestId('dlq-copy-body')).toBeTruthy();
    expect(screen.getByText(/"jobId": "j1"/)).toBeTruthy();
  });
});
