// @vitest-environment jsdom
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { measureReadout, ModelToolPanel } from './ModelToolPanel';
import { DEFAULT_SECTION, type SectionState } from './section';

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

const theme = extendTheme();
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

function renderPanel(props: Partial<Parameters<typeof ModelToolPanel>[0]> = {}) {
  const handlers = { onSectionChange: vi.fn<(section: SectionState) => void>(), onClose: vi.fn() };
  act(() =>
    root.render(
      <CssVarsProvider theme={theme}>
        <ModelToolPanel
          tool="section"
          section={DEFAULT_SECTION}
          measurePoints={[]}
          units="mm"
          {...handlers}
          {...props}
        />
      </CssVarsProvider>
    )
  );
  return handlers;
}

describe('ModelToolPanel', () => {
  it('picks an axis and flips the cut', () => {
    const { onSectionChange } = renderPanel();
    expect(byTestId('model-pane-section-axis-x')?.getAttribute('aria-checked')).toBe('true');
    act(() => byTestId('model-pane-section-axis-z')?.click());
    expect(onSectionChange).toHaveBeenLastCalledWith({ ...DEFAULT_SECTION, axis: 'z' });
    act(() => byTestId('model-pane-section-flip')?.click());
    expect(onSectionChange).toHaveBeenLastCalledWith({ ...DEFAULT_SECTION, flipped: true });
  });

  it('shows the offset as a percentage', () => {
    renderPanel({ section: { axis: 'y', offset: 0.25, flipped: false } });
    expect((byTestId('model-pane-section-offset') as HTMLInputElement | null)?.value).toBe('25');
  });

  it('closes on Esc and on its button', () => {
    const { onClose } = renderPanel();
    act(() => {
      byTestId('model-pane-section-flip')?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
      );
    });
    act(() => byTestId('model-pane-tool-close')?.click());
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('reads out a measurement', () => {
    renderPanel({ tool: 'measure', measurePoints: [new THREE.Vector3(0, 0, 0), new THREE.Vector3(3, 4, 0)] });
    expect(byTestId('model-pane-measure-readout')?.textContent).toBe('5 mm (x 3, y 0, z 4)');
    expect(byTestId('model-pane-section-flip')).toBeNull();
  });
});

describe('measureReadout', () => {
  it('says what to click until there are two points', () => {
    expect(measureReadout([], 'mm')).toBe('Click a point on the model');
    expect(measureReadout([new THREE.Vector3()], 'mm')).toBe('Click a second point');
  });
});
