import { describe, expect, it } from 'vitest';
import type { BrowserTabSummary } from '@shared/ipc';
import { browserTabUse, closeOrder, tabsToClose } from './browserTabClose';

const tab = (id: number, url = '', agentUsedAt = 0): BrowserTabSummary => ({
  id,
  title: `Tab ${id}`,
  url,
  loading: false,
  agentUsedAt,
});

const strip = [tab(1), tab(2), tab(3), tab(4)];
const ids = (tabs: BrowserTabSummary[]) => tabs.map(entry => entry.id);

describe('tabsToClose', () => {
  it('closes the tab, the others, the ones to its right, or all of them', () => {
    expect(ids(tabsToClose(strip, 2, 'this'))).toEqual([2]);
    expect(ids(tabsToClose(strip, 2, 'others'))).toEqual([1, 3, 4]);
    expect(ids(tabsToClose(strip, 2, 'right'))).toEqual([3, 4]);
    expect(ids(tabsToClose(strip, 2, 'all'))).toEqual([1, 2, 3, 4]);
  });

  it('has nothing to the right of the last tab, nothing other than a lone tab, and nothing for a gone one', () => {
    expect(tabsToClose(strip, 4, 'right')).toEqual([]);
    expect(tabsToClose([tab(1)], 1, 'others')).toEqual([]);
    expect(tabsToClose(strip, 9, 'all')).toEqual([]);
  });
});

describe('browserTabUse', () => {
  it('counts a local dev server page as in use, and a public site as not', () => {
    expect(browserTabUse(tab(1, 'http://localhost:3000/'), null)).toBe('dev-server');
    expect(browserTabUse(tab(1, 'http://app.test/login'), null)).toBe('dev-server');
    expect(browserTabUse(tab(1, 'https://example.com/'), null)).toBeNull();
    expect(browserTabUse(tab(1, ''), null)).toBeNull();
  });

  it('counts a tab the agent used during the running reply, and not one from an earlier reply', () => {
    expect(browserTabUse(tab(1, 'https://example.com/', 2_000), 1_000)).toBe('agent');
    expect(browserTabUse(tab(1, 'https://example.com/', 500), 1_000)).toBeNull();
    expect(browserTabUse(tab(1, 'https://example.com/', 2_000), null)).toBeNull();
  });

  it('counts any tab the agent ever used when the running reply began before this window saw it', () => {
    expect(browserTabUse(tab(1, 'https://example.com/', 1), 0)).toBe('agent');
    expect(browserTabUse(tab(1, 'https://example.com/', 0), 0)).toBeNull();
  });

  it('names the agent over the dev server when both hold', () => {
    expect(browserTabUse(tab(1, 'http://localhost:3000/', 2_000), 1_000)).toBe('agent');
  });
});

describe('closeOrder', () => {
  it('closes the active tab last', () => {
    expect(closeOrder([1, 2, 3], 2)).toEqual([1, 3, 2]);
    expect(closeOrder([1, 3], 2)).toEqual([1, 3]);
    expect(closeOrder([1, 3], null)).toEqual([1, 3]);
  });
});
