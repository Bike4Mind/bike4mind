import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import ContentTransformPreviewCard from './ContentTransformPreviewCard';

// The real modal reaches contexts, hooks and the API client. These cases are about the
// card's own controls, so a stub that reports the props it was opened with is enough.
vi.mock('../ProfileModal/ContentPreviewModal', () => ({
  default: ({ open, initialEditing }: { open: boolean; initialEditing: boolean }) =>
    open ? <div data-testid="preview-modal">{initialEditing ? 'edit' : 'preview'}</div> : null,
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const data = {
  title: 'A drafted post',
  content: 'Body text of the draft.',
  summary: 'A short summary.',
  suggestedTags: ['one', 'two'],
};

const renderCard = () =>
  render(
    <TestWrapper>
      <ContentTransformPreviewCard data={data} />
    </TestWrapper>
  );

describe('ContentTransformPreviewCard', () => {
  it('opens the review modal from a real button, not only from clicking the card', async () => {
    // Publishing happens inside this modal, so a mouse-only path to it puts the whole
    // feature out of reach for keyboard and screen-reader users.
    const user = userEvent.setup();
    renderCard();

    const preview = screen.getByTestId('blog-draft-preview-btn');
    expect(preview.tagName).toBe('BUTTON');

    await user.click(preview);
    expect(screen.getByTestId('preview-modal')).toHaveTextContent('preview');
  });

  it('reaches both actions by keyboard alone', async () => {
    const user = userEvent.setup();
    renderCard();

    await user.tab();
    await user.tab();
    // Whichever of the two the second stop is, both must be reachable without a mouse.
    const focusable = [screen.getByTestId('blog-draft-edit-btn'), screen.getByTestId('blog-draft-preview-btn')];
    expect(focusable).toContain(document.activeElement);

    await user.keyboard('{Enter}');
    expect(screen.getByTestId('preview-modal')).toBeInTheDocument();
  });

  it('opens straight into edit mode from the pencil', async () => {
    const user = userEvent.setup();
    renderCard();

    await user.click(screen.getByTestId('blog-draft-edit-btn'));
    expect(screen.getByTestId('preview-modal')).toHaveTextContent('edit');
  });

  it('still opens preview when the card itself is clicked', async () => {
    const user = userEvent.setup();
    renderCard();

    await user.click(screen.getByTestId('blog-draft-card'));
    expect(screen.getByTestId('preview-modal')).toHaveTextContent('preview');
  });
});
