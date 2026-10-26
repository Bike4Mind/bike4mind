import { describe, it, expect, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { AdminTab, SIDEBAR_COLLAPSED_STORAGE_KEY, SIDEBAR_EXPANDED_STORAGE_KEY } from './adminSidebarConfig';
import { useAdminSidebarCollapsed, useAdminSidebarSections } from './useAdminSidebarSections';

/** The cross-section jump this hook exists for: aiAgents -> revenue. */
const LIFECYCLE_SECTION = 'aiAgents';
const PRICING_SECTION = 'revenue';

const stored = () => JSON.parse(window.localStorage.getItem(SIDEBAR_EXPANDED_STORAGE_KEY) ?? 'null');

describe('useAdminSidebarSections', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('opens only the active tab section when the admin has no stored preference', () => {
    const { result } = renderHook(() => useAdminSidebarSections(AdminTab.ModelLifecycle));

    expect(result.current.isExpanded(LIFECYCLE_SECTION)).toBe(true);
    expect(result.current.isExpanded(PRICING_SECTION)).toBe(false);
    // Nothing is written until the admin actually chooses something.
    expect(stored()).toBeNull();
  });

  it('honours a stored collapse of the active tab section, rather than forcing it open on mount', () => {
    window.localStorage.setItem(SIDEBAR_EXPANDED_STORAGE_KEY, JSON.stringify({ [LIFECYCLE_SECTION]: false }));

    const { result } = renderHook(() => useAdminSidebarSections(AdminTab.ModelLifecycle));

    expect(result.current.isExpanded(LIFECYCLE_SECTION)).toBe(false);
  });

  it('opens the active section when the stored preference predates it', () => {
    window.localStorage.setItem(SIDEBAR_EXPANDED_STORAGE_KEY, JSON.stringify({ security: true }));

    const { result } = renderHook(() => useAdminSidebarSections(AdminTab.ModelLifecycle));

    expect(result.current.isExpanded(LIFECYCLE_SECTION)).toBe(true);
    expect(result.current.isExpanded(PRICING_SECTION)).toBe(false);
  });

  it('force-expands the section a cross-section jump lands in', () => {
    window.localStorage.setItem(SIDEBAR_EXPANDED_STORAGE_KEY, JSON.stringify({ [LIFECYCLE_SECTION]: true }));
    const { result, rerender } = renderHook(tab => useAdminSidebarSections(tab), {
      initialProps: AdminTab.ModelLifecycle,
    });
    expect(result.current.isExpanded(PRICING_SECTION)).toBe(false);

    rerender(AdminTab.CreditAnalytics);

    expect(result.current.isExpanded(PRICING_SECTION)).toBe(true);
  });

  it('never persists a forced expansion, so the next unrelated toggle cannot make it permanent', () => {
    window.localStorage.setItem(SIDEBAR_EXPANDED_STORAGE_KEY, JSON.stringify({ [PRICING_SECTION]: false }));
    const { result, rerender } = renderHook(tab => useAdminSidebarSections(tab), {
      initialProps: AdminTab.ModelLifecycle,
    });

    rerender(AdminTab.CreditAnalytics);
    expect(result.current.isExpanded(PRICING_SECTION)).toBe(true);
    // An unrelated section toggled after the jump used to serialize the whole map,
    // writing the forced expansion out over the admin's own collapse choice.
    act(() => result.current.toggleSection('docs'));

    expect(stored()).toMatchObject({ [PRICING_SECTION]: false, docs: true });
  });

  it('collapses a force-expanded section on click instead of toggling hidden state', () => {
    const { result, rerender } = renderHook(tab => useAdminSidebarSections(tab), {
      initialProps: AdminTab.ModelLifecycle,
    });
    rerender(AdminTab.CreditAnalytics);

    act(() => result.current.toggleSection(PRICING_SECTION));

    expect(result.current.isExpanded(PRICING_SECTION)).toBe(false);
    expect(stored()).toMatchObject({ [PRICING_SECTION]: false });
  });

  it("persists the admin's own toggle", () => {
    const { result } = renderHook(() => useAdminSidebarSections(AdminTab.ModelLifecycle));

    act(() => result.current.toggleSection(PRICING_SECTION));
    expect(stored()).toMatchObject({ [PRICING_SECTION]: true, [LIFECYCLE_SECTION]: true });

    act(() => result.current.toggleSection(LIFECYCLE_SECTION));
    expect(stored()).toMatchObject({ [PRICING_SECTION]: true, [LIFECYCLE_SECTION]: false });
  });
});

describe('useAdminSidebarCollapsed', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('starts expanded and persists each toggle', () => {
    const { result } = renderHook(() => useAdminSidebarCollapsed());
    expect(result.current.collapsed).toBe(false);

    act(() => result.current.toggleCollapsed());

    expect(result.current.collapsed).toBe(true);
    expect(window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY)).toBe('true');
  });

  it('restores a stored collapse', () => {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, 'true');

    const { result } = renderHook(() => useAdminSidebarCollapsed());

    expect(result.current.collapsed).toBe(true);
  });
});
