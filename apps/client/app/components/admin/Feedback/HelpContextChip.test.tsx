import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { IHelpFeedbackContext } from '@bike4mind/common';

import HelpContextChip from './HelpContextChip';

const appTheme = extendTheme({ ...getThemeConfig() });

const renderChip = (helpContext?: IHelpFeedbackContext) =>
  render(
    <CssVarsProvider theme={appTheme}>
      <HelpContextChip feedbackItem={{ helpContext }} />
    </CssVarsProvider>
  );

const chip = () => screen.queryByTestId('feedback-help-context-chip');

describe('HelpContextChip', () => {
  /**
   * The console is shared by every subject, so a report that did not come from help must not
   * grow a chip - and `helpContext` is absent rather than empty on those rows.
   */
  it('renders nothing for a report that did not come from help', () => {
    renderChip(undefined);

    expect(chip()).toBeNull();
  });

  it('names the article an article-surface report came from', () => {
    renderChip({ eventId: 'evt-1', surface: 'article', slug: 'features/keyboard-shortcuts' });

    expect(chip()).toHaveTextContent('features/keyboard-shortcuts');
  });

  /**
   * A chat report carries no slug by design - the question and answer stay on the expiring
   * HelpEvent - so the chip has to degrade to the surface instead of rendering an empty label.
   */
  it('falls back to the surface when a chat report carries no slug', () => {
    renderChip({ eventId: 'evt-2', surface: 'chat' });

    expect(chip()).toHaveTextContent('Help chat');
  });

  /**
   * The tooltip is built from the slug rather than the label, so the no-slug case must not read
   * back as "Help article: Help article".
   */
  it('does not repeat itself in the tooltip when an article has no slug', async () => {
    renderChip({ eventId: 'evt-3', surface: 'article' });

    await userEvent.hover(chip()!);

    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip).toHaveTextContent('did not record its slug');
    expect(tooltip).not.toHaveTextContent('Help article: Help article');
  });

  it('names the slug in the tooltip when there is one', async () => {
    renderChip({ eventId: 'evt-3b', surface: 'article', slug: 'features/keyboard-shortcuts' });

    await userEvent.hover(chip()!);

    expect(await screen.findByRole('tooltip')).toHaveTextContent('Help article: features/keyboard-shortcuts');
  });

  it('flags an article the reader reported as outdated', () => {
    renderChip({ eventId: 'evt-4', surface: 'article', slug: 'features/x', reportType: 'outdated' });

    expect(screen.getByTestId('feedback-help-outdated-chip')).toHaveTextContent('Outdated');
  });

  it('shows no outdated flag on a report that did not set one', () => {
    renderChip({ eventId: 'evt-5', surface: 'article', slug: 'features/x' });

    expect(screen.queryByTestId('feedback-help-outdated-chip')).toBeNull();
  });

  /**
   * An article report whose slug aged out of the record still has to be distinguishable from a
   * chat one, rather than silently borrowing the chat label.
   */
  it('keeps an article report labelled as an article when its slug is missing', () => {
    renderChip({ eventId: 'evt-3', surface: 'article' });

    expect(chip()).toHaveTextContent('Help article');
  });
});
