import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { FeedbackStatus, FeedbackType, type PromptMeta } from '@bike4mind/common';
import type { IExtendedFeedbackDocument } from './types';

const mocks = vi.hoisted(() => ({
  getFeedbackByIdFromServer: vi.fn(),
  openHelpPanel: vi.fn(),
  copyTextWithToast: vi.fn(),
}));

vi.mock('@client/app/utils/feedbackAPICalls', () => ({ getFeedbackByIdFromServer: mocks.getFeedbackByIdFromServer }));
vi.mock('@client/app/hooks/useHelpPanel', () => ({ openHelpPanel: mocks.openHelpPanel }));
vi.mock('@client/app/utils/copyToClipboard', () => ({ copyTextWithToast: mocks.copyTextWithToast }));

import FeedbackDetailDrawer, { type FeedbackDetailDrawerProps } from './FeedbackDetailDrawer';

const appTheme = extendTheme({ ...getThemeConfig() });

const makeRecord = (overrides: Partial<IExtendedFeedbackDocument> = {}): IExtendedFeedbackDocument => ({
  id: 'fb-1',
  _id: 'fb-1',
  userId: 'user-1',
  status: FeedbackStatus.New,
  username: 'reporter',
  userEmail: 'reporter@example.com',
  customerService: '',
  organization: 'acme',
  type: FeedbackType.THUMBS_DOWN,
  promptMeta: {} as PromptMeta,
  subject: 'turn',
  sessionId: 'sess-1',
  questId: 'quest-1',
  contentStored: true,
  content: 'The answer cited the wrong file.\nSecond line.',
  createdAt: new Date('2024-01-01T00:00:00.000Z'),
  updatedAt: new Date('2024-01-02T00:00:00.000Z'),
  ...overrides,
});

const renderDrawer = (props: Partial<FeedbackDetailDrawerProps> = {}) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = vi.fn();
  const onStatusChange = vi.fn().mockResolvedValue(undefined);
  render(
    <QueryClientProvider client={queryClient}>
      <CssVarsProvider theme={appTheme}>
        <FeedbackDetailDrawer feedbackId="fb-1" onClose={onClose} onStatusChange={onStatusChange} {...props} />
      </CssVarsProvider>
    </QueryClientProvider>
  );
  return { onClose, onStatusChange };
};

describe('FeedbackDetailDrawer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stays closed without a feedback id', () => {
    renderDrawer({ feedbackId: undefined });

    expect(screen.queryByTestId('feedback-detail-content')).not.toBeInTheDocument();
    expect(screen.queryByTestId('feedback-detail-position')).not.toBeInTheDocument();
    expect(mocks.getFeedbackByIdFromServer).not.toHaveBeenCalled();
  });

  it('shows the full text, type, subject and reporter', async () => {
    mocks.getFeedbackByIdFromServer.mockResolvedValue(makeRecord());

    renderDrawer();

    expect(await screen.findByTestId('feedback-detail-content')).toHaveTextContent(
      'The answer cited the wrong file. Second line.'
    );
    expect(screen.getByTestId('feedback-detail-type')).toHaveTextContent('Thumbs Down');
    expect(screen.getByTestId('feedback-detail-subject')).toHaveTextContent('Conversation turn');
    expect(screen.getByTestId('feedback-detail-reporter')).toHaveTextContent('reporter@example.com');
    expect(screen.getByTestId('feedback-detail-reporter')).toHaveTextContent('acme');
  });

  it('links a turn report at the turn, in a new tab', async () => {
    mocks.getFeedbackByIdFromServer.mockResolvedValue(makeRecord());

    renderDrawer();

    const link = await screen.findByTestId('feedback-detail-open-conversation-btn');
    expect(link).toHaveTextContent('Open conversation at this turn');
    expect(link).toHaveAttribute('href', '/notebooks/sess-1?questId=quest-1');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('opens the help article a help report was written on', async () => {
    mocks.getFeedbackByIdFromServer.mockResolvedValue(
      makeRecord({
        subject: 'help',
        sessionId: undefined,
        questId: undefined,
        helpContext: { eventId: 'evt-1', surface: 'article', slug: 'features/export' },
      })
    );

    renderDrawer();

    await userEvent.click(await screen.findByTestId('feedback-detail-open-article-btn'));
    expect(mocks.openHelpPanel).toHaveBeenCalledWith('features/export');
    expect(screen.queryByTestId('feedback-detail-open-conversation-btn')).not.toBeInTheDocument();
  });

  it('summarizes the turn instead of dumping promptMeta', async () => {
    mocks.getFeedbackByIdFromServer.mockResolvedValue(
      makeRecord({
        promptMeta: {
          model: { name: 'claude-opus-5-5', backend: 'anthropic' },
          functionCalls: [{ name: 'web_search', returnValue: 'SECRET TOOL OUTPUT' }],
          tokenUsage: { inputTokens: 1200, outputTokens: 300, totalTokens: 1500 },
        } as PromptMeta,
      })
    );

    renderDrawer();

    expect(await screen.findByTestId('feedback-detail-turn-model')).toHaveTextContent('claude-opus-5-5 (anthropic)');
    expect(screen.getByTestId('feedback-detail-turn-tools')).toHaveTextContent('web_search');
    expect(screen.getByTestId('feedback-detail-turn-tokens')).toHaveTextContent('1,200 in, 300 out (1,500 total)');
    expect(screen.getByTestId('feedback-detail-drawer')).not.toHaveTextContent('SECRET TOOL OUTPUT');
  });

  it('shows the list row while the full record loads', () => {
    mocks.getFeedbackByIdFromServer.mockReturnValue(new Promise(() => {}));

    renderDrawer({ listRow: makeRecord({ content: 'From the list' }) });

    expect(screen.getByTestId('feedback-detail-content')).toHaveTextContent('From the list');
    expect(screen.getByTestId('feedback-detail-turn-loading')).toBeInTheDocument();
  });

  it('says so when the report is gone or not readable', async () => {
    mocks.getFeedbackByIdFromServer.mockRejectedValue(new Error('Not found'));

    renderDrawer();

    expect(await screen.findByTestId('feedback-detail-missing')).toBeInTheDocument();
  });

  it('shows the place in the list and wires previous and next', async () => {
    mocks.getFeedbackByIdFromServer.mockResolvedValue(makeRecord());
    const onNext = vi.fn();

    renderDrawer({ position: { index: 3, total: 40 }, onNext });

    expect(screen.getByTestId('feedback-detail-position')).toHaveTextContent('3 of 40');
    expect(screen.getByTestId('feedback-detail-previous-btn')).toBeDisabled();
    await userEvent.click(screen.getByTestId('feedback-detail-next-btn'));
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape', async () => {
    mocks.getFeedbackByIdFromServer.mockResolvedValue(makeRecord());

    const { onClose } = renderDrawer();
    await screen.findByTestId('feedback-detail-content');

    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('changes the status from the drawer', async () => {
    const record = makeRecord();
    mocks.getFeedbackByIdFromServer.mockResolvedValue(record);

    const { onStatusChange } = renderDrawer();

    await userEvent.click(await screen.findByTestId('feedback-detail-status-select'));
    await userEvent.click(await screen.findByRole('option', { name: 'Closed' }));

    await waitFor(() =>
      expect(onStatusChange).toHaveBeenCalledWith(expect.objectContaining({ _id: 'fb-1' }), FeedbackStatus.Closed)
    );
  });
});
