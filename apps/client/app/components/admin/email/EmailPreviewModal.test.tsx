import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { EmailSendStatus } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import EmailPreviewModal from './EmailPreviewModal';

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: vi.fn() } }));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({
    isLoading: false,
    data: {
      id: 'a1',
      recipientEmail: 'r@example.com',
      recipientType: 'direct',
      status: EmailSendStatus.SENT,
      renderedSubject: 'Subject',
      renderedHtml: '<p>hello</p>',
    },
  }),
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

// The rendered email HTML carries recipient-derived substitutions; it must render in an
// opaque-origin sandbox so it cannot run with the admin's app-origin session.
describe('EmailPreviewModal', () => {
  it('renders the email HTML inside a sandboxed iframe', () => {
    render(
      <TestWrapper>
        <EmailPreviewModal open attemptId="a1" onClose={() => {}} />
      </TestWrapper>
    );

    const iframe = screen.getByTitle('Email Preview') as HTMLIFrameElement;
    expect(iframe.getAttribute('sandbox')).toBe('');
    expect(iframe.getAttribute('sandbox')).not.toContain('allow-same-origin');
  });
});
