import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import type { ICustomPageDocument } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import useSessionLayout from '@client/app/hooks/useSessionLayout';
import { useActiveCustomPage } from '@client/app/components/CustomPage/pageChatContext';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  toastError: vi.fn(),
  pageQuery: {} as Record<string, unknown>,
  sessionContainerProps: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mocks.navigate,
  useParams: () => ({ id: 'a'.repeat(24) }),
}));
vi.mock('sonner', () => ({ toast: { error: (...args: unknown[]) => mocks.toastError(...args) } }));
vi.mock('@client/app/hooks/data/customPages', () => ({ useCustomPage: () => mocks.pageQuery }));
vi.mock('@client/app/hooks/useDocumentTitle', () => ({ useDocumentTitle: () => undefined }));
vi.mock('@client/app/hooks/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('@client/app/contexts/SessionsContext', () => ({ useSessions: () => ({ currentSessionId: 's1' }) }));
vi.mock('@client/app/components/Session/SessionContainer', () => ({
  default: (props: Record<string, unknown>) => {
    mocks.sessionContainerProps(props);
    return <div data-testid="session-container" />;
  },
}));
vi.mock('@client/app/components/CustomPage/CustomPageBody', () => ({
  default: ({ page }: { page: ICustomPageDocument }) => <div data-testid="custom-page-body">{page.name}</div>,
}));

import CustomPagePage from './$id';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const page: ICustomPageDocument = {
  id: 'a'.repeat(24),
  userId: 'u1',
  name: 'Daily menu',
  state: {},
  widgets: [],
  orchestratorSessionId: 's1',
  version: 0,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.pageQuery = {};
  useSessionLayout.setState({ layout: 'vertical' });
});

describe('CustomPagePage', () => {
  it('renders the page body beside the orchestrator chat and forces the hide layout while mounted', () => {
    mocks.pageQuery = { data: page, isLoading: false, isError: false };
    const view = render(<CustomPagePage />, { wrapper: TestWrapper });

    expect(screen.getByTestId('custom-page-body').textContent).toBe('Daily menu');
    expect(screen.getByTestId('custom-page-chat')).toBeTruthy();
    expect(mocks.sessionContainerProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ currentSessionId: 's1', autoHideOnEmpty: false })
    );
    expect(useSessionLayout.getState().layout).toBe('hide');
    expect(useActiveCustomPage.getState()).toMatchObject({ page, currentSessionId: 's1' });

    view.unmount();
    expect(useSessionLayout.getState().layout).toBe('vertical');
    expect(useActiveCustomPage.getState().page).toBeNull();
  });

  it.each([404, 403])('toasts once and navigates to /new on %s', status => {
    mocks.pageQuery = {
      data: undefined,
      isLoading: false,
      isError: true,
      error: { isAxiosError: true, response: { status } },
    };
    const view = render(<CustomPagePage />, { wrapper: TestWrapper });
    view.rerender(<CustomPagePage />);

    expect(mocks.toastError).toHaveBeenCalledTimes(1);
    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/new' });
    expect(screen.queryByTestId('session-container')).toBeNull();
  });
});
