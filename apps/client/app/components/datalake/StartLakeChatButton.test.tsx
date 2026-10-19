import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { ISessionDocument } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  startChatWithLake: vi.fn(),
  promoteMutateAsync: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@client/app/hooks/useStartChatWithLake', () => ({ default: () => h.startChatWithLake }));
vi.mock('@client/app/hooks/data/dataLakes', () => ({
  usePromoteDataLake: () => ({ mutateAsync: h.promoteMutateAsync, isPending: false }),
}));
vi.mock('sonner', () => ({ toast: { error: h.toastError } }));

import StartLakeChatButton from './StartLakeChatButton';

const appTheme = extendTheme({ ...getThemeConfig() });
const wrap = (ui: ReactNode) => render(<CssVarsProvider theme={appTheme}>{ui}</CssVarsProvider>);

const SESSION = { id: 'session-1' } as ISessionDocument;
const ACTIVE_LAKE = { id: 'lake1', status: 'active' as const };

const renderButton = (
  over: {
    startChatForLake?: (dataLakeId: string) => Promise<void>;
    onChatStarted?: (session: ISessionDocument) => void | Promise<void>;
  } = {}
) =>
  wrap(
    <StartLakeChatButton lake={ACTIVE_LAKE} testId="start-chat-btn" {...over}>
      Ask about this repo
    </StartLakeChatButton>
  );

const clickAndSettle = async () => {
  await act(async () => {
    fireEvent.click(screen.getByTestId('start-chat-btn'));
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  h.startChatWithLake.mockResolvedValue(SESSION);
});

describe('StartLakeChatButton', () => {
  it('uses caller-owned creation without invoking the generic lake chat hook', async () => {
    const startChatForLake = vi.fn().mockResolvedValue(undefined);
    renderButton({ startChatForLake });
    await clickAndSettle();

    expect(startChatForLake).toHaveBeenCalledWith('lake1');
    expect(h.startChatWithLake).not.toHaveBeenCalled();
  });

  it('prefers caller-owned creation over a supplied completion', async () => {
    const startChatForLake = vi.fn().mockResolvedValue(undefined);
    const onChatStarted = vi.fn();
    renderButton({ startChatForLake, onChatStarted });
    await clickAndSettle();

    expect(startChatForLake).toHaveBeenCalledWith('lake1');
    expect(h.startChatWithLake).not.toHaveBeenCalled();
    expect(onChatStarted).not.toHaveBeenCalled();
  });

  it('toasts a failure when caller-owned creation rejects', async () => {
    const startChatForLake = vi.fn().mockRejectedValue(new Error('create failed'));
    renderButton({ startChatForLake });
    await clickAndSettle();

    await waitFor(() => expect(h.toastError).toHaveBeenCalledWith('Could not start a chat with this lake'));
    expect(h.startChatWithLake).not.toHaveBeenCalled();
  });

  it('hands a caller-supplied completion to the chat hook', async () => {
    const onChatStarted = vi.fn();
    renderButton({ onChatStarted });
    await clickAndSettle();

    expect(h.startChatWithLake).toHaveBeenCalledWith('lake1', { onCreated: onChatStarted });
    expect(h.toastError).not.toHaveBeenCalled();
  });

  it('lets the hook navigate when the caller supplies no completion', async () => {
    renderButton();
    await clickAndSettle();

    expect(h.startChatWithLake).toHaveBeenCalledWith('lake1');
  });

  it('toasts a failure when the start rejects, which a failing completion also does', async () => {
    h.startChatWithLake.mockRejectedValueOnce(new Error('completion failed'));
    renderButton({ onChatStarted: vi.fn() });
    await clickAndSettle();

    await waitFor(() => expect(h.toastError).toHaveBeenCalledWith('Could not start a chat with this lake'));
  });
});
