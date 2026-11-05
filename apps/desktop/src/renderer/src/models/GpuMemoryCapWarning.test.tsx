// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GpuMemoryCap } from '@shared/models';
import { desktopTheme } from '../theme';
import { GpuMemoryCapWarning } from './GpuMemoryCapWarning';

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

const GIB = 1024 ** 3;
const CAP: GpuMemoryCap = { model: 'qwen3.8:27b-q8_0', sizeBytes: 38.4 * GIB, gpuBytes: 19.2 * GIB };

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
});

const show = (serverId: string, cap: GpuMemoryCap | null) =>
  act(async () =>
    root.render(
      <CssVarsProvider theme={desktopTheme}>
        <GpuMemoryCapWarning serverId={serverId} cap={cap} />
      </CssVarsProvider>
    )
  );
const warning = () => host.querySelector<HTMLElement>('[data-testid="models-gpu-cap-warning"]');
const dismiss = () =>
  act(async () => host.querySelector<HTMLElement>('[data-testid="models-gpu-cap-dismiss-btn"]')?.click());

describe('GpuMemoryCapWarning', () => {
  it('says what happened, why, and what to do', async () => {
    await show('local', CAP);
    const text = warning()?.textContent ?? '';
    expect(text).toContain('qwen3.8:27b-q8_0 loaded with 19.2 GiB of its 38.4 GiB on the GPU');
    expect(text).toContain("limits GPU memory to the WSL virtual machine's memory");
    expect(text).toContain('run partly on the CPU');
    expect(text).toContain('.wslconfig');
    expect(text).not.toMatch(/[^\x20-\x7e]/);
  });

  it('shows nothing without a cap', async () => {
    await show('local', null);
    expect(warning()).toBeNull();
  });

  it('leaves out sizes that are not finite', async () => {
    await show('local', { ...CAP, sizeBytes: Number.NaN, gpuBytes: Number.POSITIVE_INFINITY });
    const text = warning()?.textContent ?? '';
    expect(text).toContain('qwen3.8:27b-q8_0 loaded partly on the CPU');
    expect(text).not.toMatch(/NaN|Infinity/);
  });

  it('stays dismissed for that server until the cap clears and comes back', async () => {
    await show('dismiss-a', CAP);
    await dismiss();
    expect(warning()).toBeNull();
    await show('dismiss-a', { ...CAP, gpuBytes: 20 * GIB });
    expect(warning()).toBeNull();
    await show('dismiss-b', CAP);
    expect(warning()).not.toBeNull();
    await show('dismiss-a', null);
    await show('dismiss-a', CAP);
    expect(warning()).not.toBeNull();
  });
});
