import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { ModelInfo, PromptMeta } from '@bike4mind/common';

const modelCatalog = vi.hoisted(() => ({ current: [] as Array<Record<string, unknown>> }));

vi.mock('@client/app/hooks/data/useModelInfo', () => ({
  useModelInfo: () => ({ data: modelCatalog.current }),
}));

import ContextVisualizer from './ContextVisualizer';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

// A redirected turn: the reply was produced by gemini-3.5-flash after the requested
// gemini-2.5-pro was redirected away.
const redirectedTurn = (): PromptMeta => ({
  model: { name: 'gemini-3.5-flash', contextWindow: 128000 },
  redirectedFrom: 'gemini-2.5-pro',
  tokenUsage: { inputTokens: 1000, outputTokens: 100 },
});

describe('ContextVisualizer model attribution', () => {
  beforeEach(() => {
    modelCatalog.current = [];
  });

  it('looks up and shows the answering model from the catalog', () => {
    modelCatalog.current = [
      { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', contextWindow: 1000000, max_tokens: 8192 },
    ] as unknown as ModelInfo[];

    render(<ContextVisualizer promptMeta={redirectedTurn()} />, { wrapper: TestWrapper });

    expect(screen.getByText(/Gemini 3.5 Flash/)).toBeTruthy();
    // The successor's window, not the requested model's 128k. (It shows in both the header and the
    // box-count line, so assert presence rather than a single node.)
    expect(screen.getAllByText(/1\.0M/).length).toBeGreaterThan(0);
  });

  it('names the answering model even when the catalog has not loaded it', () => {
    render(<ContextVisualizer promptMeta={redirectedTurn()} />, { wrapper: TestWrapper });

    expect(screen.getByText(/gemini-3\.5-flash/)).toBeTruthy();
    // No catalog entry, so the recorded window is the only source.
    expect(screen.getAllByText(/128\.0k/).length).toBeGreaterThan(0);
  });
});
