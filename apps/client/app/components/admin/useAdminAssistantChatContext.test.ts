import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const h = vi.hoisted(() => ({ search: {} as Record<string, unknown> }));

vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({ state: { location: { search: h.search } } }),
}));

import { getSurfaceChatContext } from '@client/app/utils/surfaceChatContext';
import { ADMIN_USERS_TAB_SLUG } from '@bike4mind/common';
import { AdminTab } from './adminSidebarConfig';
import { useAdminAssistantChatContext } from './useAdminAssistantChatContext';

describe('useAdminAssistantChatContext', () => {
  beforeEach(() => {
    h.search = {};
  });

  it('registers a provider describing the active tab and unregisters on unmount', () => {
    const { unmount } = renderHook(() => useAdminAssistantChatContext(AdminTab.Users));

    const context = getSurfaceChatContext();
    expect(context.viewDescription).toBe(`Admin > People > Users (tab: ${ADMIN_USERS_TAB_SLUG})`);
    expect(context.briefContext).toBeUndefined();

    unmount();
    expect(getSurfaceChatContext()).toEqual({});
  });

  it('includes selected-entity search params in briefContext', () => {
    h.search = { tab: ADMIN_USERS_TAB_SLUG, userId: '507f1f77bcf86cd799439011', redirectTo: '/somewhere' };
    renderHook(() => useAdminAssistantChatContext(AdminTab.Users));

    const { briefContext } = getSurfaceChatContext();
    expect(briefContext).toContain('userId=507f1f77bcf86cd799439011');
    expect(briefContext).not.toContain('redirectTo');
  });

  it('provides nothing for a non-tab active value', () => {
    renderHook(() => useAdminAssistantChatContext(null));
    expect(getSurfaceChatContext()).toEqual({});
  });
});
