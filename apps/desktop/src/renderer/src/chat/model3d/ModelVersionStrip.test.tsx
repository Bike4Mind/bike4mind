// @vitest-environment jsdom
import { CssVarsProvider } from '@mui/joy/styles';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_MODEL_STATE, type ModelVersionEntry } from '@shared/model3d';
import { desktopTheme } from '../../theme';
import { ModelVersionBanner, ModelVersionStrip, pngDataUrl, versionTime, versionTitle } from './ModelVersionStrip';
import { currentVersion } from './useModelVersions';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom ships no matchMedia, and Joy's colour-scheme provider asks for one on mount.
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

// The app's own theme: the strip uses its palette tokens, which a bare Joy theme lacks.
const theme = desktopTheme;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);

function show(node: ReactNode) {
  act(() => root.render(<CssVarsProvider theme={theme}>{node}</CssVarsProvider>));
}

const version = (number: number, extra: Partial<ModelVersionEntry> = {}): ModelVersionEntry => ({
  number,
  path: '/project/chest.model.js',
  source: `source ${number}`,
  jointAngles: {},
  createdAt: Date.UTC(2026, 10, 18, 9, number),
  thumbnail: new Uint8Array([137, 80, 78, 71]),
  ...extra,
});

describe('ModelVersionStrip', () => {
  it('shows one labelled thumbnail per version, oldest first, and presses the current one', () => {
    show(
      <ModelVersionStrip
        versions={[version(3), version(4), version(5)]}
        current={5}
        selected={null}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    );
    const buttons = [...container.querySelectorAll<HTMLButtonElement>('[data-testid^="model-version-"]')];
    expect(buttons.map(button => button.dataset.testid)).toEqual([
      'model-version-3',
      'model-version-4',
      'model-version-5',
    ]);
    expect(buttons.map(button => button.textContent)).toEqual(['v3', 'v4', 'v5']);
    expect(byTestId('model-version-5')?.getAttribute('aria-pressed')).toBe('true');
    expect(byTestId('model-version-3')?.querySelector('img')?.getAttribute('src')).toBe(
      pngDataUrl(new Uint8Array([137, 80, 78, 71]))
    );
  });

  it('presses the selected version over the current one', () => {
    show(
      <ModelVersionStrip
        versions={[version(1), version(2)]}
        current={2}
        selected={1}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    );
    expect(byTestId('model-version-1')?.getAttribute('aria-pressed')).toBe('true');
    expect(byTestId('model-version-2')?.getAttribute('aria-pressed')).toBe('false');
  });

  it('draws a version without a thumbnail as its label alone', () => {
    show(
      <ModelVersionStrip
        versions={[version(1, { thumbnail: null })]}
        current={1}
        selected={null}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    );
    expect(byTestId('model-version-1')?.querySelector('img')).toBeNull();
    expect(byTestId('model-version-1')?.textContent).toBe('v1');
  });

  it('selects a version on click', () => {
    const onSelect = vi.fn();
    show(
      <ModelVersionStrip
        versions={[version(1), version(2)]}
        current={2}
        selected={null}
        onSelect={onSelect}
        onClose={vi.fn()}
      />
    );
    act(() => byTestId('model-version-1')?.click());
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('moves focus between versions with the arrow keys', () => {
    show(
      <ModelVersionStrip
        versions={[version(1), version(2), version(3)]}
        current={3}
        selected={null}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    );
    byTestId('model-version-2')?.focus();
    act(() => {
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    });
    expect(document.activeElement).toBe(byTestId('model-version-1'));
    act(() => {
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    });
    expect(document.activeElement).toBe(byTestId('model-version-1'));
  });

  it('goes back to the current build on Escape only while a version is selected', () => {
    const onClose = vi.fn();
    const press = () =>
      act(() => {
        byTestId('model-version-1')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });
    show(
      <ModelVersionStrip
        versions={[version(1), version(2)]}
        current={2}
        selected={null}
        onSelect={vi.fn()}
        onClose={onClose}
      />
    );
    press();
    expect(onClose).not.toHaveBeenCalled();
    show(
      <ModelVersionStrip
        versions={[version(1), version(2)]}
        current={2}
        selected={1}
        onSelect={vi.fn()}
        onClose={onClose}
      />
    );
    press();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('renders nothing with no versions', () => {
    show(<ModelVersionStrip versions={[]} current={null} selected={null} onSelect={vi.fn()} onClose={vi.fn()} />);
    expect(byTestId('model-versions')).toBeNull();
  });

  it('names the version, its note and whether it is current', () => {
    const entry = version(4, { note: 'Restored v1' });
    expect(versionTitle(entry, true)).toBe(
      `v4 \u00b7 ${versionTime(entry.createdAt)} \u00b7 Restored v1 \u00b7 current`
    );
  });
});

describe('ModelVersionBanner', () => {
  function banner(props: Partial<Parameters<typeof ModelVersionBanner>[0]> = {}) {
    const handlers = { onCompareChange: vi.fn(), onRestore: vi.fn(), onClose: vi.fn() };
    show(
      <ModelVersionBanner
        version={version(2, { note: 'width = 40' })}
        current={5}
        compare={null}
        status="ready"
        restoring={false}
        {...handlers}
        {...props}
      />
    );
    return handlers;
  }

  it('says which version is previewed and what made it', () => {
    banner();
    expect(byTestId('model-version-banner-title')?.textContent).toBe('Previewing v2 \u00b7 width = 40');
  });

  it('says what a compare is against', () => {
    banner({ compare: 'overlay' });
    expect(byTestId('model-version-banner-title')?.textContent).toContain('Comparing v2 with v5');
    banner({ compare: 'side', current: null });
    expect(byTestId('model-version-banner-title')?.textContent).toContain('Comparing v2 with the file now');
  });

  it('turns a compare mode on and off', () => {
    const { onCompareChange } = banner();
    act(() => byTestId('model-version-compare-overlay')?.click());
    expect(onCompareChange).toHaveBeenLastCalledWith('overlay');
    banner({ compare: 'overlay', ...{ onCompareChange } });
    act(() => byTestId('model-version-compare-overlay')?.click());
    expect(onCompareChange).toHaveBeenLastCalledWith(null);
  });

  it('restores, and closes on the button or Escape', () => {
    const { onRestore, onClose } = banner();
    act(() => byTestId('model-version-restore')?.click());
    expect(onRestore).toHaveBeenCalledOnce();
    act(() => byTestId('model-version-close')?.click());
    act(() => {
      byTestId('model-version-banner')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('holds compare until the version has built, and shows a build error', () => {
    banner({ status: 'building' });
    expect(byTestId('model-version-compare-side')?.hasAttribute('disabled')).toBe(true);
    banner({ status: { error: 'nope is not defined' } });
    expect(byTestId('model-version-error')?.textContent).toBe('nope is not defined');
  });
});

describe('currentVersion', () => {
  const state = { ...EMPTY_MODEL_STATE, path: '/project/chest.model.js', kind: 'model' as const, source: 'b' };

  it('is the newest version matching the file and source', () => {
    const versions = [version(1, { source: 'b' }), version(2, { source: 'a' }), version(3, { source: 'b' })];
    expect(currentVersion(versions, state)).toBe(3);
  });

  it('is null after an edit not kept yet, for another file, or for an opened asset', () => {
    expect(currentVersion([version(1, { source: 'a' })], state)).toBeNull();
    expect(currentVersion([version(1, { source: 'b', path: '/project/lamp.model.js' })], state)).toBeNull();
    expect(currentVersion([version(1, { source: 'b' })], { ...state, kind: 'glb', source: null })).toBeNull();
  });
});
