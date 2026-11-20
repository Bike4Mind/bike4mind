import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderModelsRoute } from './modelsTestUtils';

vi.mock('./List/ModelListSection', () => ({ ModelListSection: () => <div data-testid="stub-list" /> }));
vi.mock('./Prices/ModelPricesSection', () => ({ ModelPricesSection: () => <div data-testid="stub-prices" /> }));
vi.mock('./Discovery/DiscoverySection', () => ({ DiscoverySection: () => <div data-testid="stub-discovery" /> }));
vi.mock('./Discovery/RunDiscoveryButton', () => ({ RunDiscoveryButton: () => null }));
vi.mock('./Settings/ModelSettingsSection', () => ({
  ModelSettingsSection: () => <div data-testid="stub-settings" />,
}));
vi.mock('@client/app/components/help/ContextHelpButton', () => ({ default: () => null }));

import ModelsShell from './ModelsShell';

afterEach(cleanup);

describe('ModelsShell', () => {
  it('opens the section the URL names', async () => {
    await renderModelsRoute('/admin?tab=models&modelsSection=discovery', ModelsShell);
    expect(screen.getByTestId('stub-discovery')).toBeInTheDocument();
  });

  it('defaults to the model list and ignores an unknown section', async () => {
    await renderModelsRoute('/admin?tab=models&modelsSection=bogus', ModelsShell);
    expect(screen.getByTestId('stub-list')).toBeInTheDocument();
  });

  it("switches sections in the URL and drops the previous section's params", async () => {
    const { router } = await renderModelsRoute(
      '/admin?tab=models&modelsView=listed&modelsQuery=example&model=example-text-1',
      ModelsShell
    );
    fireEvent.click(screen.getByTestId('models-sections-prices-btn'));

    await waitFor(() => expect(screen.getByTestId('stub-prices')).toBeInTheDocument());
    expect(router.state.location.search).toEqual({ tab: 'models', modelsSection: 'prices' });
  });
});
