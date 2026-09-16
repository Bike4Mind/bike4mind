import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const mocks = vi.hoisted(() => ({ copyTextWithToast: vi.fn() }));

vi.mock('@client/app/utils/copyToClipboard', () => ({ copyTextWithToast: mocks.copyTextWithToast }));

import FeedbackRowLinks from './FeedbackRowLinks';

const appTheme = extendTheme({ ...getThemeConfig() });

const renderLinks = (feedbackItem: { _id: string; sessionId?: string; questId?: string }) =>
  render(
    <CssVarsProvider theme={appTheme}>
      <FeedbackRowLinks feedbackItem={feedbackItem} />
    </CssVarsProvider>
  );

const conversationLink = () => screen.queryByTestId('feedback-open-conversation-btn');

describe('FeedbackRowLinks', () => {
  beforeEach(() => {
    mocks.copyTextWithToast.mockReset();
  });

  /**
   * The copied link is the one that leaves the app for Slack or a ticket, so it has to be
   * absolute and carry both the tab slug and the record id - a path alone is unusable there.
   */
  it('copies an absolute link that opens the admin tab on this record', async () => {
    renderLinks({ _id: 'fb-1' });

    await userEvent.click(screen.getByTestId('feedback-copy-link-btn'));

    const [copied] = mocks.copyTextWithToast.mock.calls[0];
    expect(copied).toBe(`${window.location.origin}/admin?tab=feedback&feedbackId=fb-1`);
  });

  // The slug, not AdminTab's positional number: these links outlive any one deploy.
  it('does not put the tab enum number in the copied link', async () => {
    renderLinks({ _id: 'fb-1' });

    await userEvent.click(screen.getByTestId('feedback-copy-link-btn'));

    expect(mocks.copyTextWithToast.mock.calls[0][0]).toContain('tab=feedback');
    expect(mocks.copyTextWithToast.mock.calls[0][0]).not.toMatch(/tab=\d/);
  });

  it('links a turn-level report straight at the turn', () => {
    renderLinks({ _id: 'fb-1', sessionId: 'sess-1', questId: 'quest-1' });

    expect(conversationLink()).toHaveAttribute('href', '/notebooks/sess-1?questId=quest-1');
  });

  // A session-level report names no turn, so the link degrades to the session rather than
  // building one with an empty questId that ChatHistory would never match.
  it('links a session-level report at the session', () => {
    renderLinks({ _id: 'fb-1', sessionId: 'sess-1' });

    expect(conversationLink()).toHaveAttribute('href', '/notebooks/sess-1');
  });

  it('offers no conversation link for a product-level report', () => {
    renderLinks({ _id: 'fb-1' });

    expect(conversationLink()).not.toBeInTheDocument();
  });

  // Triage happens with filters and a page cursor on screen; routing away would discard both.
  it('opens the conversation in a new tab, without leaking the referrer', () => {
    renderLinks({ _id: 'fb-1', sessionId: 'sess-1', questId: 'quest-1' });

    expect(conversationLink()).toHaveAttribute('target', '_blank');
    expect(conversationLink()).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('escapes ids rather than letting them inject query params', () => {
    renderLinks({ _id: 'fb-1', sessionId: 'sess-1?tab=users', questId: 'q&x=1' });

    const href = conversationLink()?.getAttribute('href') ?? '';
    expect(href).toBe('/notebooks/sess-1%3Ftab%3Dusers?questId=q%26x%3D1');
  });
});
