import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import ClientContextChips from './ClientContextChips';

const appTheme = extendTheme({ ...getThemeConfig() });

const renderChips = (clientContext?: Parameters<typeof ClientContextChips>[0]['feedbackItem']['clientContext']) =>
  render(
    <CssVarsProvider theme={appTheme}>
      <ClientContextChips feedbackItem={{ clientContext }} />
    </CssVarsProvider>
  );

describe('ClientContextChips', () => {
  it('renders nothing for a report from before context was captured', () => {
    renderChips(undefined);
    expect(screen.queryByTestId('feedback-client-context')).toBeNull();
  });

  it('renders platform, version, page, viewport and model', () => {
    renderChips({
      platform: 'web',
      appVersion: '1.2.3',
      path: '/notebooks',
      viewport: { width: 1280, height: 720 },
      model: 'some-model',
      userAgent: 'agent/1.0',
    });

    expect(screen.getByTestId('feedback-client-context-platform')).toHaveTextContent('web');
    expect(screen.getByTestId('feedback-client-context-version')).toHaveTextContent('v1.2.3');
    expect(screen.getByTestId('feedback-client-context-path')).toHaveTextContent('/notebooks');
    expect(screen.getByTestId('feedback-client-context-viewport')).toHaveTextContent('1280x720');
    expect(screen.getByTestId('feedback-client-context-model')).toHaveTextContent('some-model');
  });

  it('still shows something when only the user agent was captured', () => {
    renderChips({ userAgent: 'agent/1.0' });
    expect(screen.getByTestId('feedback-client-context-ua')).toBeInTheDocument();
  });
});
