import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import type { ModelInfo } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import PromptCacheTtlChip from './PromptCacheTtlChip';
import { promptCacheTtlPrices } from './promptCacheTtlPrices';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const OPUS = {
  id: 'claude-opus-5-5',
  name: 'Opus',
  type: 'text',
  backend: 'anthropic',
  contextWindow: 1_000_000,
  max_tokens: 64_000,
  pricing: { 1_000_000: { input: 4 / 1_000_000, output: 20 / 1_000_000 } },
} as unknown as ModelInfo;

describe('promptCacheTtlPrices', () => {
  it('prices this chat at both TTLs, the hour at 2x input against 1.25x', () => {
    const prices = promptCacheTtlPrices(OPUS, 150_000, OPUS.id)!;
    expect(prices.basis).toBe('chat');
    expect(prices.credits['1h'] / prices.credits['5m']).toBeCloseTo(1.6, 1);
  });

  it('quotes per 100K tokens before the chat has a prompt, and nothing for a free model', () => {
    expect(promptCacheTtlPrices(OPUS, undefined, undefined)?.basis).toBe('per100k');
    expect(promptCacheTtlPrices({ ...OPUS, freeToRun: true } as ModelInfo, 150_000, OPUS.id)).toBeNull();
  });
});

describe('PromptCacheTtlChip', () => {
  const prices = { credits: { '5m': 3_800, '1h': 6_000 }, basis: 'chat' as const };

  it('shows the current TTL and both prices, and reports a pick', () => {
    const onChange = vi.fn();
    render(<PromptCacheTtlChip value="5m" prices={prices} onChange={onChange} />, { wrapper: TestWrapper });
    expect(screen.getByTestId('prompt-cache-ttl-chip').textContent).toBe('Cache 5m');

    fireEvent.click(screen.getByTestId('prompt-cache-ttl-chip'));
    expect(screen.getByTestId('prompt-cache-ttl-option-5m-price').textContent).toBe(
      'About 3,800 credits to cache this chat'
    );
    expect(screen.getByTestId('prompt-cache-ttl-option-1h-price').textContent).toBe(
      'About 6,000 credits to cache this chat'
    );
    fireEvent.click(screen.getByTestId('prompt-cache-ttl-option-1h'));
    expect(onChange).toHaveBeenCalledWith('1h');
  });
});
