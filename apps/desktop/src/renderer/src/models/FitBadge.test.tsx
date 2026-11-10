// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HubBuildView, HubModelView, ModelFit } from '@shared/models';
import { desktopTheme } from '../theme';
import { FitBadge } from './FitBadge';
import { PullDialog } from './PullDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
})) as typeof window.matchMedia;

const WARNING =
  "Ollama 0.40.15 in WSL limits GPU memory to the WSL virtual machine's memory, so if this model needs more than that, it runs partly on the CPU and replies slowly.";
const fit = (level: ModelFit['level'], warning?: string): ModelFit => ({
  level,
  detail: `Rated ${level} at the 32K context chat will use.`,
  basis: 'arch',
  context: 32768,
  ...(warning ? { warning } : {}),
});

let root: Root;
let host: HTMLElement;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const render = (node: ReactNode) =>
  act(async () => root.render(<CssVarsProvider theme={desktopTheme}>{node}</CssVarsProvider>));
const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe('FitBadge', () => {
  it.each(['fits', 'tight'] as const)('flags a %s badge and keeps its verdict, reason first', async level => {
    await render(<FitBadge fit={fit(level, WARNING)} />);
    const badge = q('models-fit-badge');
    expect(badge?.textContent).toBe(level === 'fits' ? 'Fits' : 'Tight');
    expect(badge?.dataset.level).toBe(level);
    expect(badge?.dataset.warning).toBe('true');
    expect(badge?.querySelector('[data-testid="models-fit-warning-flag"]')?.getAttribute('aria-label')).toBe('Warning');
    // A closed describeChild tooltip leaves its text in the chip's title.
    expect(badge?.getAttribute('title')).toBe(`Rated ${level} at the 32K context chat will use.\n${WARNING}`);
  });

  it('shows no flag without a warning', async () => {
    await render(<FitBadge fit={fit('fits')} />);
    const badge = q('models-fit-badge');
    expect(badge?.dataset.warning).toBeUndefined();
    expect(q('models-fit-warning-flag')).toBeNull();
    expect(badge?.getAttribute('title')).toBe('Rated fits at the 32K context chat will use.');
  });

  it('keeps the flag on a bare badge, whose reason is printed beside it', async () => {
    await render(<FitBadge fit={fit('fits', WARNING)} bare />);
    expect(q('models-fit-badge')?.getAttribute('title')).toBeNull();
    expect(q('models-fit-warning-flag')).not.toBeNull();
  });
});

describe('PullDialog fit', () => {
  const model: HubModelView = {
    id: 'Qwen/Qwen3-8B-GGUF',
    author: 'Qwen',
    downloads: null,
    likes: null,
    updatedAt: null,
    licenses: ['apache-2.0'],
    gated: false,
    private: false,
    abliterated: false,
    url: 'https://huggingface.co/Qwen/Qwen3-8B-GGUF',
    revision: 'b'.repeat(40),
    licenseNames: ['Apache 2.0'],
    licenseUrl: 'https://huggingface.co/Qwen/Qwen3-8B-GGUF/blob/main/LICENSE',
    licenseHost: 'huggingface.co',
    licenseKind: 'permissive',
    baseModels: [],
    builds: [],
    projectorBytes: null,
    needsAccess: false,
    hubAccess: 'no-token',
  };
  const build = (buildFit: ModelFit): HubBuildView => ({
    id: 'qwen3-8b-q8_0',
    label: 'Q8_0',
    sizeBytes: 8 * 1024 ** 3,
    ollamaRef: 'hf.co/Qwen/Qwen3-8B-GGUF:Q8_0',
    installedNames: [],
    blockedReason: null,
    importParts: null,
    importLargestBytes: null,
    fit: buildFit,
  });
  const show = (buildFit: ModelFit) => {
    vi.stubGlobal('b4m', { models: { getStoreLocation: vi.fn(() => new Promise(() => {})) } });
    return render(
      <PullDialog
        model={model}
        build={build(buildFit)}
        target={{ id: 'local', name: 'This computer', local: true, management: 'allowed' }}
        onConfirm={() => {}}
        onClose={() => {}}
      />
    );
  };

  it('prints the warning after the reason, and the download needs no extra tick', async () => {
    await show(fit('fits', WARNING));
    const text = q('models-pull-dialog-fit')?.textContent ?? '';
    expect(text.indexOf('Rated fits')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf(WARNING)).toBeGreaterThan(text.indexOf('Rated fits'));
    expect(q('models-pull-dialog-fit-warning')?.textContent).toBe(WARNING);
    expect(q('models-pull-dialog-fit-checkbox')).toBeNull();
  });

  it('prints no warning line without one', async () => {
    await show(fit('fits'));
    expect(q('models-pull-dialog-fit')?.textContent).toContain('Rated fits');
    expect(q('models-pull-dialog-fit-warning')).toBeNull();
  });
});
