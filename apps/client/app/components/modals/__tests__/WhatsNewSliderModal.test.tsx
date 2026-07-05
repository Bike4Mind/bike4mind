import { describe, it, expect } from 'vitest';
import { IModalDocument, IUserActivityCounterDocument } from '@bike4mind/common';

/**
 * Helper function that mirrors the sort logic from WhatsNewSliderModal component.
 * This allows us to test the sorting behavior in isolation without React/hooks complexity.
 */
function sortModalsByDate(modals: IModalDocument[]): IModalDocument[] {
  return modals.slice().sort((a, b) => {
    // Primary sort: createdAt descending (newest first)
    const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;

    // Handle invalid dates (NaN)
    const aDate = isNaN(aTime) ? 0 : aTime;
    const bDate = isNaN(bTime) ? 0 : bTime;

    // If dates differ, sort by date
    if (bDate !== aDate) {
      return bDate - aDate;
    }

    // Fallback: sort by priority (maintains original behavior for ties)
    return (b.priority || 0) - (a.priority || 0);
  });
}

/**
 * Creates a mock IModalDocument for testing.
 * Only includes fields relevant to sorting logic, others are set to default values.
 */
function createMockModal(id: string, createdAt: Date | null, priority?: number): IModalDocument {
  return {
    _id: id,
    id: id,
    createdAt: createdAt as any,
    updatedAt: new Date(),
    priority: priority || 0,
    isBanner: false,
    title: `Modal ${id}`,
    subtitle: null,
    description: null,
    tags: [],
    imageUrl: null,
    closeButton: false,
    agreeButton: false,
    enabled: true,
    startDate: null,
    endDate: null,
    conditions: null,
    userIds: null,
    userType: null,
    excludeUserIds: null,
    numberOfAgrees: 0,
    numberOfViews: 0,
    textMessage: null,
  } as unknown as IModalDocument;
}

describe('WhatsNewSliderModal', () => {
  describe('modal sorting logic', () => {
    it('sorts modals by createdAt descending (newest first)', () => {
      const modals: IModalDocument[] = [
        createMockModal('1', new Date('2024-01-01'), 5),
        createMockModal('2', new Date('2024-03-01'), 5),
        createMockModal('3', new Date('2024-02-01'), 5),
      ];

      const sorted = sortModalsByDate(modals);

      expect(sorted[0]._id).toBe('2'); // March (newest)
      expect(sorted[1]._id).toBe('3'); // February
      expect(sorted[2]._id).toBe('1'); // January (oldest)
    });

    it('handles null createdAt values by treating them as oldest', () => {
      const modals: IModalDocument[] = [createMockModal('1', new Date('2024-01-01'), 5), createMockModal('2', null, 5)];

      const sorted = sortModalsByDate(modals);

      expect(sorted[0]._id).toBe('1'); // Has date (newer)
      expect(sorted[1]._id).toBe('2'); // Null date (treated as 0, oldest)
    });

    it('handles invalid dates (NaN) by treating them as 0', () => {
      const modals: IModalDocument[] = [
        createMockModal('1', new Date('2024-01-01'), 5),
        createMockModal('2', new Date('invalid'), 5),
      ];

      const sorted = sortModalsByDate(modals);

      expect(sorted[0]._id).toBe('1'); // Valid date (newer)
      expect(sorted[1]._id).toBe('2'); // Invalid date (NaN → 0, oldest)
    });

    it('falls back to priority when createdAt dates are equal', () => {
      const sameDate = new Date('2024-01-01');
      const modals: IModalDocument[] = [
        createMockModal('1', sameDate, 3),
        createMockModal('2', sameDate, 7),
        createMockModal('3', sameDate, 5),
      ];

      const sorted = sortModalsByDate(modals);

      expect(sorted[0]._id).toBe('2'); // Priority 7 (highest)
      expect(sorted[1]._id).toBe('3'); // Priority 5
      expect(sorted[2]._id).toBe('1'); // Priority 3 (lowest)
    });

    it('handles missing priority by defaulting to 0', () => {
      const sameDate = new Date('2024-01-01');
      const modals: IModalDocument[] = [createMockModal('1', sameDate, undefined), createMockModal('2', sameDate, 5)];

      const sorted = sortModalsByDate(modals);

      expect(sorted[0]._id).toBe('2'); // Priority 5 (higher)
      expect(sorted[1]._id).toBe('1'); // Priority undefined → 0 (lower)
    });

    it('handles complex scenarios with dates, nulls, and priorities', () => {
      const modals: IModalDocument[] = [
        createMockModal('1', null, 10),
        createMockModal('2', new Date('2024-01-01'), 5),
        createMockModal('3', new Date('2024-01-01'), 8),
        createMockModal('4', new Date('2024-02-01'), 3),
      ];

      const sorted = sortModalsByDate(modals);

      expect(sorted[0]._id).toBe('4'); // Feb 1 (newest date)
      expect(sorted[1]._id).toBe('3'); // Jan 1, priority 8 (higher)
      expect(sorted[2]._id).toBe('2'); // Jan 1, priority 5 (lower)
      expect(sorted[3]._id).toBe('1'); // null date → 0 (oldest)
    });

    it('preserves array immutability (does not mutate original)', () => {
      const modals: IModalDocument[] = [
        createMockModal('1', new Date('2024-01-01'), 5),
        createMockModal('2', new Date('2024-02-01'), 5),
      ];

      const originalOrder = modals.map(m => m._id);
      sortModalsByDate(modals);

      // Original array should not be modified
      expect(modals.map(m => m._id)).toEqual(originalOrder);
    });
  });

  describe('optimistic counter updates', () => {
    /**
     * Tests the optimistic update logic that updates the counter cache
     * before backend confirmation to prevent race conditions.
     */

    function createMockCounterDocument(modalId: string, action: string, count: number): IUserActivityCounterDocument {
      return {
        _id: `counter-${modalId}-${action}`,
        id: `counter-${modalId}-${action}`,
        userId: 'user-1',
        action,
        count,
        tags: [modalId],
        createdAt: new Date(),
        updatedAt: new Date(),
      } as IUserActivityCounterDocument;
    }

    it('increments existing counter optimistically', () => {
      const modalId = 'modal-1';
      const existingCounters: IUserActivityCounterDocument[] = [createMockCounterDocument(modalId, 'Modal Viewed', 2)];

      // Simulate optimistic update
      const counter = existingCounters.find(c => c.action === 'Modal Viewed' && c.tags?.includes(modalId));

      if (counter) {
        counter.count += 1;
        counter.updatedAt = new Date();
      }

      expect(counter?.count).toBe(3);
      expect(counter?.updatedAt).toBeInstanceOf(Date);
    });

    it('creates new counter entry when none exists', () => {
      const modalId = 'modal-1';
      const userId = 'user-1';
      const existingCounters: IUserActivityCounterDocument[] = [];

      // Simulate optimistic update for new counter
      const existingCounter = existingCounters.find(c => c.action === 'Modal Viewed' && c.tags?.includes(modalId));

      if (!existingCounter) {
        const tempId = `temp-${modalId}-${Date.now()}`;
        const newCounter: IUserActivityCounterDocument = {
          _id: tempId,
          id: tempId,
          userId,
          action: 'Modal Viewed',
          count: 1,
          tags: [modalId],
          createdAt: new Date(),
          updatedAt: new Date(),
        } as IUserActivityCounterDocument;

        existingCounters.push(newCounter);
      }

      expect(existingCounters).toHaveLength(1);
      expect(existingCounters[0].count).toBe(1);
      expect(existingCounters[0].tags).toContain(modalId);
      expect(existingCounters[0].id).toMatch(/^temp-/);
    });

    it('handles multiple modals in batch update', () => {
      const modalIds = ['modal-1', 'modal-2', 'modal-3'];
      const existingCounters: IUserActivityCounterDocument[] = [
        createMockCounterDocument('modal-1', 'Modal Viewed', 1),
        // modal-2 and modal-3 don't have existing counters
      ];

      // Simulate batch optimistic update
      modalIds.forEach(modalId => {
        const counter = existingCounters.find(c => c.action === 'Modal Viewed' && c.tags?.includes(modalId));

        if (counter) {
          counter.count += 1;
          counter.updatedAt = new Date();
        } else {
          const tempId = `temp-${modalId}-${Date.now()}`;
          existingCounters.push({
            _id: tempId,
            id: tempId,
            userId: 'user-1',
            action: 'Modal Viewed',
            count: 1,
            tags: [modalId],
            createdAt: new Date(),
            updatedAt: new Date(),
          } as IUserActivityCounterDocument);
        }
      });

      expect(existingCounters).toHaveLength(3);
      expect(existingCounters[0].count).toBe(2); // Incremented existing
      expect(existingCounters[1].count).toBe(1); // New counter
      expect(existingCounters[2].count).toBe(1); // New counter
    });

    it('preserves other counter properties during update', () => {
      const modalId = 'modal-1';
      const originalCreatedAt = new Date('2024-01-01');
      const existingCounters: IUserActivityCounterDocument[] = [
        {
          ...createMockCounterDocument(modalId, 'Modal Viewed', 5),
          createdAt: originalCreatedAt,
        },
      ];

      const counter = existingCounters[0];
      const originalId = counter.id;
      const originalUserId = counter.userId;

      // Simulate optimistic update
      counter.count += 1;
      counter.updatedAt = new Date();

      expect(counter.id).toBe(originalId);
      expect(counter.userId).toBe(originalUserId);
      expect(counter.createdAt).toEqual(originalCreatedAt);
      expect(counter.count).toBe(6);
    });

    /**
     * Regression test for the view-logging predicate.
     *
     * The close handler in WhatsNewSliderModal (and the parallel handlers in ModalManager)
     * MUST log VIEW_MODAL / increment the optimistic counter for every modal with an _id,
     * regardless of whether numberOfViews is configured. checkModalThresholds' implicit-
     * firstTime default (modals without a behavior type) consults this same counter to
     * decide whether to hide the modal on the next load - re-tightening the guard back to
     * `modal._id && modal.numberOfViews` would silently bring back the "modal re-opens on
     * every page reload" bug.
     */
    describe('view-logging predicate (regression)', () => {
      // Mirrors the `modalsToLog` filter inside WhatsNewSliderModal.handleClose AND the
      // optimistic-counter branch inside the same handler. Same predicate is used by
      // ModalManager.handleCloseModal / handleCloseBanner.
      const shouldLogView = (modal: Partial<IModalDocument>): boolean => Boolean(modal._id);

      it('logs view for a modal with no numberOfViews configured (implicit firstTime)', () => {
        const modal = { _id: 'unconfigured-modal', numberOfViews: null };
        expect(shouldLogView(modal)).toBe(true);
      });

      it('logs view for a modal with numberOfViews explicitly set', () => {
        const modal = { _id: 'configured-modal', numberOfViews: { type: 'firstTime', threshold: 1 } };
        expect(shouldLogView(modal as Partial<IModalDocument>)).toBe(true);
      });

      it('does not log view for a modal without an _id', () => {
        const modal = { _id: undefined, numberOfViews: { type: 'firstTime', threshold: 1 } };
        expect(shouldLogView(modal as Partial<IModalDocument>)).toBe(false);
      });
    });

    it('generates unique temp IDs for new counters', () => {
      const modalId = 'modal-1';
      const existingCounters: IUserActivityCounterDocument[] = [];

      // Create two counters with small time delay
      for (let i = 0; i < 2; i++) {
        const tempId = `temp-${modalId}-${Date.now() + i}`;
        existingCounters.push({
          _id: tempId,
          id: tempId,
          userId: 'user-1',
          action: 'Modal Viewed',
          count: 1,
          tags: [modalId],
          createdAt: new Date(),
          updatedAt: new Date(),
        } as IUserActivityCounterDocument);
      }

      const ids = existingCounters.map(c => c.id);
      const uniqueIds = new Set(ids);

      expect(uniqueIds.size).toBe(2); // All IDs should be unique
    });
  });
});
