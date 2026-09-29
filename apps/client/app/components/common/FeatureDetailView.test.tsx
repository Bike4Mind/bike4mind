import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { GEAR_PRESENTATION } from '@client/lib/gears/presentation';
import FeatureDetailView from './FeatureDetailView';

const appTheme = extendTheme({ ...getThemeConfig() });

const itemFor = (key: string) => ({ key, ...GEAR_PRESENTATION[key] });

const renderDetail = (key: string, onBack = vi.fn()) => {
  const item = itemFor(key);
  render(
    <CssVarsProvider theme={appTheme}>
      <FeatureDetailView
        item={item}
        onBack={onBack}
        testIdPrefix="gear-detail"
        cta={<button data-testid="detail-cta">{item.cta}</button>}
      />
    </CssVarsProvider>
  );
  return { item, onBack };
};

describe('FeatureDetailView', () => {
  it('shows all four sections for a feature with authored copy, and no in-progress notice', () => {
    renderDetail('mementos');

    expect(screen.getByText('What it does')).toBeInTheDocument();
    expect(screen.getByText('Why it works this way')).toBeInTheDocument();
    expect(screen.getByText('When to use it')).toBeInTheDocument();
    expect(screen.getByText('Gotchas')).toBeInTheDocument();
    expect(screen.queryByTestId('gear-detail-wip-mementos')).not.toBeInTheDocument();
  });

  it('shows the intro and says the rest is in progress for a feature without copy yet', () => {
    const { item } = renderDetail('apikey');

    expect(screen.getByText(item.intro)).toBeInTheDocument();
    expect(screen.getByTestId('gear-detail-wip-apikey')).toHaveTextContent('Description in progress');
    // Sections with no copy are left out rather than shown empty.
    expect(screen.queryByText('Gotchas')).not.toBeInTheDocument();
  });

  it('renders the CTA it is given', () => {
    const { item } = renderDetail('mementos');
    expect(screen.getByTestId('detail-cta')).toHaveTextContent(item.cta);
  });

  it('renders the aside it is given in the header', () => {
    const item = itemFor('mementos');
    render(
      <CssVarsProvider theme={appTheme}>
        <FeatureDetailView
          item={item}
          onBack={vi.fn()}
          testIdPrefix="gear-detail"
          cta={null}
          aside={<span data-testid="detail-aside">100</span>}
        />
      </CssVarsProvider>
    );
    expect(screen.getByTestId('detail-aside')).toHaveTextContent('100');
  });

  it('calls onBack when Back is clicked', async () => {
    const { onBack } = renderDetail('mementos');
    await userEvent.click(screen.getByTestId('gear-detail-back-btn'));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
