import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { FeedbackStatus } from '@bike4mind/common';
import { useFeedbackFilters } from '../useFeedbackFilters';

/**
 * The hook's whole job is translating filter UI state into the GET /api/feedback query, so the
 * assertions here are on `filterParams` rather than on any filtered array: the filtering itself
 * now happens server-side, because the list is paginated and a client predicate can only filter
 * the page on screen.
 */
describe('useFeedbackFilters', () => {
  let onFilterChange: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onFilterChange = vi.fn();
  });

  const setup = () => renderHook(() => useFeedbackFilters(onFilterChange));

  it('queries only New feedback by default, newest first', () => {
    const { result } = setup();

    expect(result.current.filters.statusFilters).toEqual({
      [FeedbackStatus.New]: true,
      [FeedbackStatus.InProgress]: false,
      [FeedbackStatus.Closed]: false,
    });
    expect(result.current.filterParams).toEqual({
      status: [FeedbackStatus.New],
      sort: 'desc',
    });
  });

  it('sends every checked status', () => {
    const { result } = setup();

    act(() => {
      result.current.setStatusFilters(previous => ({ ...previous, [FeedbackStatus.InProgress]: true }));
    });

    expect(result.current.filterParams.status).toEqual([FeedbackStatus.New, FeedbackStatus.InProgress]);
  });

  it('sends only the checked status when New is unchecked', () => {
    const { result } = setup();

    act(() => {
      result.current.setStatusFilters({
        [FeedbackStatus.New]: false,
        [FeedbackStatus.InProgress]: false,
        [FeedbackStatus.Closed]: true,
      });
    });

    expect(result.current.filterParams.status).toEqual([FeedbackStatus.Closed]);
  });

  /**
   * Load-bearing: with no status checked the key is OMITTED, and an absent `status` is the
   * server's "any status". So this state cannot be sent as a query - it would invert the UI's
   * "nothing checked means nothing shown" into "show everything". useFeedbackOperations is what
   * holds that line, by disabling the list query while `status` is empty; this test pins the
   * fact that gate exists to cover.
   */
  it('omits status entirely when nothing is checked', () => {
    const { result } = setup();

    act(() => {
      result.current.setStatusFilters({
        [FeedbackStatus.New]: false,
        [FeedbackStatus.InProgress]: false,
        [FeedbackStatus.Closed]: false,
      });
    });

    expect(result.current.filterParams).not.toHaveProperty('status');
  });

  /**
   * Regression guard. The organization filter used to be inert end to end: the old client-side
   * predicate read `selectedOrganization` from OrganizationContext (nothing sets it, so it was
   * fixed at ['all'] and always passed) while the dropdown wrote to a separate
   * `selectedOrganizations` state that nothing read. The dropdown must reach the query.
   */
  it('sends the organizations picked in the dropdown', () => {
    const { result } = setup();

    act(() => {
      result.current.setSelectedOrganizations(['acme', 'globex']);
    });

    expect(result.current.filterParams.organization).toEqual(['acme', 'globex']);
  });

  it('omits organization when the dropdown is cleared', () => {
    const { result } = setup();

    act(() => {
      result.current.setSelectedOrganizations(['acme']);
    });
    act(() => {
      result.current.setSelectedOrganizations([]);
    });

    expect(result.current.filterParams).not.toHaveProperty('organization');
  });

  /**
   * The gap this filter closed: GET /api/feedback has always accepted `subject`, and the console
   * never sent one - so the server-side filter was unreachable and every subject landed in one
   * queue. These pin that the control reaches the query.
   */
  describe('subject', () => {
    it('sends no subject by default, so every subject is listed', () => {
      const { result } = setup();

      expect(result.current.filters.subject).toBeUndefined();
      expect(result.current.filterParams).not.toHaveProperty('subject');
    });

    it('sends the selected subject', () => {
      const { result } = setup();

      act(() => {
        result.current.setSubject('turn');
      });

      expect(result.current.filters.subject).toBe('turn');
      expect(result.current.filterParams.subject).toBe('turn');
    });

    // Single-valued on the wire: picking a second subject replaces the first rather than adding
    // to it, because the endpoint's `subject` is one enum value and not an array.
    it('replaces the previous subject rather than accumulating', () => {
      const { result } = setup();

      act(() => {
        result.current.setSubject('turn');
      });
      act(() => {
        result.current.setSubject('product');
      });

      expect(result.current.filterParams.subject).toBe('product');
    });

    it('omits subject again when cleared back to all', () => {
      const { result } = setup();

      act(() => {
        result.current.setSubject('session');
      });
      act(() => {
        result.current.setSubject(undefined);
      });

      expect(result.current.filterParams).not.toHaveProperty('subject');
    });

    it('leaves the other filters alone', () => {
      const { result } = setup();

      act(() => {
        result.current.setSubject('session');
      });

      expect(result.current.filterParams).toEqual({
        status: [FeedbackStatus.New],
        subject: 'session',
        sort: 'desc',
      });
    });
  });

  it('flips the sort direction without touching the other filters', () => {
    const { result } = setup();

    act(() => {
      result.current.toggleSortDirection();
    });

    expect(result.current.filterParams).toEqual({ status: [FeedbackStatus.New], sort: 'asc' });
  });

  // Every filter edit must reset the page cursor, or narrowing the filters can leave the caller
  // on a page number the new, shorter result set does not reach - which renders as an empty list.
  it('notifies the caller on every filter change so the page cursor resets', () => {
    const { result } = setup();

    act(() => result.current.setSearchTerm('a'));
    act(() => result.current.setStatusFilters(previous => previous));
    act(() => result.current.setSelectedOrganizations(['acme']));
    act(() => result.current.setSubject('turn'));
    act(() => result.current.toggleSortDirection());

    expect(onFilterChange).toHaveBeenCalledTimes(5);
  });

  describe('search', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('keeps the typed term out of the query until the debounce settles', () => {
      const { result } = setup();

      act(() => {
        result.current.setSearchTerm('crash');
      });

      // Echoed to the input immediately, but not yet a request.
      expect(result.current.filters.searchTerm).toBe('crash');
      expect(result.current.filterParams).not.toHaveProperty('search');

      act(() => {
        vi.advanceTimersByTime(300);
      });

      expect(result.current.filterParams.search).toBe('crash');
    });

    it('trims the term and omits a whitespace-only one', () => {
      const { result } = setup();

      act(() => {
        result.current.setSearchTerm('  crash  ');
      });
      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(result.current.filterParams.search).toBe('crash');

      act(() => {
        result.current.setSearchTerm('   ');
      });
      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(result.current.filterParams).not.toHaveProperty('search');
    });
  });
});
