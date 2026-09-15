import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, act, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getThemeConfig } from '../../utils/themes';
import type { ISessionDocument } from '@bike4mind/common';

vi.mock('@client/app/hooks/data/sessions', () => ({
  useUpdateSession: () => ({ mutate: vi.fn() }),
}));

vi.mock('@client/app/contexts/SessionsContext', () => ({
  useSessions: () => ({ setCurrentSession: vi.fn() }),
}));

import SessionRenameInput from './RenameInput';

const appTheme = extendTheme({ ...getThemeConfig() });

const TestWrapper = ({ children }: { children: React.ReactNode }) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={queryClient}>
      <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
    </QueryClientProvider>
  );
};

const makeSession = (overrides: Partial<ISessionDocument> = {}): ISessionDocument =>
  ({
    id: 'sess-1',
    name: 'My Notebook',
    ...overrides,
  }) as ISessionDocument;

describe('SessionRenameInput', () => {
  // Regression: clicking Rename on the currently selected notebook (header
  // Dropdown) caused the parent's Dropdown to unmount around the just-mounted input.
  // A spurious blur fired before focus settled, hitting the `name === session.name`
  // branch and calling onSuccess(), making the rename appear to no-op.
  it('ignores a blur that fires before the post-mount focus settles', async () => {
    const onSuccess = vi.fn();
    const session = makeSession();
    const { getByDisplayValue } = render(
      <TestWrapper>
        <SessionRenameInput session={session} initialValue={session.name} onSuccess={onSuccess} />
      </TestWrapper>
    );

    const input = getByDisplayValue('My Notebook') as HTMLInputElement;

    // Synchronously blur in the same tick the component mounts, before the
    // deferred-focus timer fires. Mirrors the race where MUI's Dropdown unmounts
    // around the input and restores focus elsewhere on the same task.
    fireEvent.blur(input);
    expect(onSuccess).not.toHaveBeenCalled();

    // After the deferred focus settles, blur behaves normally.
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    fireEvent.blur(input);
    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
  });
});
