// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SidebarSectionsState } from '@shared/sidebarSections';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useSidebarSections } from './useSidebarSections';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const initial: SidebarSectionsState = { sections: [{ id: 'a', name: 'Work' }], assignments: {} };
const renamed: SidebarSectionsState = { sections: [{ id: 'a', name: 'Day job' }], assignments: {} };

let root: Root | null = null;
let host: HTMLElement | null = null;
let latest: ReturnType<typeof useSidebarSections> | null = null;

function Probe() {
  latest = useSidebarSections();
  return null;
}

async function mount(renameSection: (id: string, name: string) => Promise<SidebarSectionsState>) {
  (window as unknown as { b4m: unknown }).b4m = {
    sidebar: { getSections: () => Promise.resolve(initial), renameSection },
  };
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root?.render(<Probe />));
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  latest = null;
  vi.restoreAllMocks();
});

describe('useSidebarSections', () => {
  it('applies the state main answers with', async () => {
    await mount(() => Promise.resolve(renamed));
    expect(latest?.sections).toEqual(initial);

    await act(async () => latest?.actions.rename('a', 'Day job'));

    expect(latest?.sections).toEqual(renamed);
  });

  it('keeps the previous state when the call rejects', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await mount(() => Promise.reject(new Error('disk full')));

    await act(async () => latest?.actions.rename('a', 'Day job'));

    expect(latest?.sections).toEqual(initial);
    expect(error).toHaveBeenCalled();
  });
});
