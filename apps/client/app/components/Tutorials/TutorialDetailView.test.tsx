import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import TutorialDetailView from './TutorialDetailView';
import { tutorialItemsFor } from './tutorialCatalog';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const item = tutorialItemsFor('advanced').find(i => i.key === 'mementos')!;

const renderDetail = (onBack = vi.fn()) => {
  render(
    <TestWrapper>
      <TutorialDetailView item={item} onBack={onBack} />
    </TestWrapper>
  );
  return { onBack };
};

describe('TutorialDetailView', () => {
  it('renders the call to action as a label, not a control', () => {
    renderDetail();
    const cta = screen.getByTestId(`tutorial-detail-cta-${item.key}`);

    // Nothing on this page is wired yet, so the CTA must not present itself as a
    // button - the rule TutorialCard already follows for its own un-wired CTA.
    expect(cta.tagName).not.toBe('BUTTON');
    expect(cta.closest('button')).toBeNull();
    expect(cta).toHaveTextContent(item.cta);
  });

  it('leaves Back as the only control', () => {
    renderDetail();
    const buttons = screen.getAllByRole('button');

    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveAttribute('data-testid', 'tutorial-detail-back-btn');
  });

  it('calls onBack when Back is clicked', async () => {
    const { onBack } = renderDetail();
    await userEvent.click(screen.getByTestId('tutorial-detail-back-btn'));

    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('shows the authored sections for a feature that has them', () => {
    renderDetail();

    expect(screen.getByText('What it does')).toBeInTheDocument();
    expect(screen.getByText('Why it works this way')).toBeInTheDocument();
    expect(screen.getByText('When to use it')).toBeInTheDocument();
    expect(screen.getByText('Gotchas')).toBeInTheDocument();
  });
});
