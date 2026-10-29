import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const settings = vi.hoisted(() => ({ loaded: true, enableLoops: false }));
vi.mock('@client/app/contexts/AdminSettingsContext', () => ({
  useAdminSettings: () => ({
    authedSettingsLoaded: settings.loaded,
    getSettingBoolean: (key: string, fallback: boolean) => (key === 'EnableLoops' ? settings.enableLoops : fallback),
  }),
}));

import { LoopsGate } from './LoopsGate';

const renderGate = () =>
  render(
    <LoopsGate loadingFallback={<div data-testid="loading" />}>
      <div data-testid="loops-page" />
    </LoopsGate>
  );

describe('LoopsGate', () => {
  it('renders nothing, not a gate panel, while EnableLoops is off', () => {
    Object.assign(settings, { loaded: true, enableLoops: false });
    const { container } = renderGate();
    expect(container).toBeEmptyDOMElement();
  });

  it('waits for the authed settings', () => {
    Object.assign(settings, { loaded: false, enableLoops: false });
    renderGate();
    expect(screen.getByTestId('loading')).toBeInTheDocument();
    expect(screen.queryByTestId('loops-page')).toBeNull();
  });

  it('renders the page while EnableLoops is on', () => {
    Object.assign(settings, { loaded: true, enableLoops: true });
    renderGate();
    expect(screen.getByTestId('loops-page')).toBeInTheDocument();
  });
});
