import { describe, expect, it } from 'vitest';
import { designTokens } from '../tokens';
import { emitCssVariables } from './cssVariables';

describe('css variables emitter', () => {
  const css = emitCssVariables(designTokens);

  it('emits scheme, typography, metric and motion variables', () => {
    expect(css).toContain(`  --b4m-color-divider: ${designTokens.color.schemes.light.divider};`);
    expect(css).toContain(`  --b4m-color-text-primary: ${designTokens.color.schemes.light.text.primary};`);
    expect(css).toContain('[data-b4m-color-scheme="dark"] {');
    expect(css).toContain(`  --b4m-color-background-surface2: ${designTokens.color.schemes.dark.background.surface2};`);
    expect(css).toContain('--b4m-font-size-md: 1rem;');
    expect(css).toContain('--b4m-radius-md: 8px;');
    expect(css).toContain('--b4m-spacing-unit: 8px;');
    expect(css).toContain('--b4m-duration-fast: 150ms;');
    expect(css).toContain('--b4m-shadow-xs: 0px 1px 2px 0px rgba(21 21 21 / 0.08);');
  });

  it('skips token references, which only a platform palette can resolve', () => {
    expect(designTokens.color.schemes.light.background.sidebarItem).toBe('neutral.200');
    expect(css).not.toContain('neutral.200');
  });
});
