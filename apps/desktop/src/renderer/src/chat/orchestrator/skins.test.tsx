// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { resetSkinsForTests, useSkins, type SkinsState } from './skins';
import { sampleSkinSummary } from './sampleSkin';
import { DEFAULT_SKIN_THEME } from './statePalette';
import { createThemedMount } from './testUtils';

const themed = createThemedMount();

async function readStore(): Promise<SkinsState> {
  let seen: SkinsState | undefined;
  const Probe = () => {
    seen = useSkins();
    return null;
  };
  await themed.render(<Probe />);
  if (!seen) throw new Error('store not read');
  return seen;
}

afterEach(() => {
  themed.unmount();
  resetSkinsForTests();
  window.localStorage.clear();
});

describe('the skins store', () => {
  it('uses the default theme but keeps the pick while the picked skin is broken', async () => {
    resetSkinsForTests([{ status: 'broken', id: 'nightglass', error: 'bad file' }], 'nightglass');

    const store = await readStore();

    expect(store.theme).toEqual(DEFAULT_SKIN_THEME);
    expect(store.selectedId).toBe('nightglass');
  });

  it('uses the default theme but keeps the pick while the picked skin is missing', async () => {
    resetSkinsForTests([sampleSkinSummary()], 'gone');

    const store = await readStore();

    expect(store.theme).toEqual(DEFAULT_SKIN_THEME);
    expect(store.selectedId).toBe('gone');
  });
});
