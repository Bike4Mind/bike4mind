import { afterEach, describe, expect, it } from 'vitest';
import {
  getAdminViewSummaryForLLM,
  registerContributedViews,
  resetContributedViews,
  type NavigableView,
} from '@bike4mind/common';
import { buildViewRegistryAdminMessages } from './viewRegistryPrompt';

const contributedView: NavigableView = {
  id: 'admin.ext.example',
  section: 'admin',
  label: 'Example page',
  description: 'An example page used by tests',
  navigationType: 'route',
  target: '/admin/ext/example',
  keywords: ['sample'],
  requiresAdmin: true,
};

const adminPageContext = [{ content: '[Current View Context] The admin page. Path: /admin' }];

describe('buildViewRegistryAdminMessages with a contributed view', () => {
  afterEach(resetContributedViews);

  it('lists the contributed view for an admin', () => {
    registerContributedViews([contributedView]);
    const [message] = buildViewRegistryAdminMessages({ isAdmin: true, extraContextMessages: [] });
    expect(message.requiresTool).toBe('navigate_view');
    expect(message.content).toContain('- admin.ext.example: Example page \u2014 An example page used by tests');
    expect(message.content).toBe(getAdminViewSummaryForLLM());
  });

  it('adds nothing for a non-admin, with or without the admin page nudge', () => {
    registerContributedViews([contributedView]);
    expect(buildViewRegistryAdminMessages({ isAdmin: false, extraContextMessages: [] })).toEqual([]);
    const [nudge] = buildViewRegistryAdminMessages({ isAdmin: false, extraContextMessages: adminPageContext });
    expect(nudge.content).not.toContain('admin.ext.');
  });

  it('is unchanged for an admin when nothing is contributed', () => {
    const [message] = buildViewRegistryAdminMessages({ isAdmin: true, extraContextMessages: [] });
    expect(message.content).toBe(getAdminViewSummaryForLLM());
    expect(message.content).not.toContain('admin.ext.');
  });
});
