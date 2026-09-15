import { describe, it, expect, vi } from 'vitest';
import { IModal, IUser, IUserActivityCounterDocument } from '@bike4mind/common';
import { filterModals, modalStorage } from '../modalHelpers';

/**
 * Creates a mock IModal for testing.
 */
function createMockModal(overrides: Partial<IModal> = {}): IModal {
  return {
    _id: 'modal-1',
    title: 'Test Modal',
    description: 'Test description',
    enabled: true,
    priority: 0,
    isBanner: false,
    tags: [],
    closeButton: true,
    agreeButton: false,
    imageUrl: null,
    subtitle: null,
    startDate: null,
    endDate: null,
    numberOfViews: null,
    numberOfAgrees: null,
    textMessage: null,
    ...overrides,
  };
}

/**
 * Creates a mock IUser for testing.
 */
function createMockUser(overrides: Partial<IUser> = {}): IUser {
  return {
    _id: 'user-1',
    id: 'user-1',
    email: 'test@example.com',
    firstName: 'Test',
    lastName: 'User',
    ...overrides,
  } as IUser;
}

/**
 * Creates a mock IUserActivityCounterDocument for testing.
 */
function createMockCounter(
  action: string,
  count: number,
  tags: string[] = [],
  updatedAt: Date = new Date()
): IUserActivityCounterDocument {
  return {
    _id: `counter-${action}`,
    id: `counter-${action}`,
    userId: 'user-1',
    action,
    count,
    tags,
    createdAt: new Date(),
    updatedAt,
  } as IUserActivityCounterDocument;
}

describe('modalHelpers', () => {
  describe('filterModals', () => {
    const user = createMockUser();
    const counters: IUserActivityCounterDocument[] = [];

    describe('basic filtering', () => {
      it('filters out disabled modals', () => {
        const modals: IModal[] = [
          createMockModal({ _id: 'modal-1', enabled: true }),
          createMockModal({ _id: 'modal-2', enabled: false }),
          createMockModal({ _id: 'modal-3', enabled: true }),
        ];

        const filtered = filterModals(modals, user, counters);

        expect(filtered).toHaveLength(2);
        expect(filtered.map(m => m._id)).toEqual(['modal-1', 'modal-3']);
      });

      it('sorts by priority descending (higher priority first)', () => {
        const modals: IModal[] = [
          createMockModal({ _id: 'modal-1', priority: 5 }),
          createMockModal({ _id: 'modal-2', priority: 10 }),
          createMockModal({ _id: 'modal-3', priority: 3 }),
        ];

        const filtered = filterModals(modals, user, counters);

        expect(filtered.map(m => m._id)).toEqual(['modal-2', 'modal-1', 'modal-3']);
      });

      it('filters modals by start date', () => {
        const futureDate = new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString(); // Tomorrow
        const pastDate = new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString(); // Yesterday

        const modals: IModal[] = [
          createMockModal({ _id: 'modal-1', startDate: pastDate }),
          createMockModal({ _id: 'modal-2', startDate: futureDate }),
          createMockModal({ _id: 'modal-3', startDate: null }),
        ];

        const filtered = filterModals(modals, user, counters);

        expect(filtered.map(m => m._id)).toEqual(['modal-1', 'modal-3']);
      });

      it('filters modals by end date', () => {
        const futureDate = new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString(); // Tomorrow
        const pastDate = new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString(); // Yesterday

        const modals: IModal[] = [
          createMockModal({ _id: 'modal-1', endDate: futureDate }),
          createMockModal({ _id: 'modal-2', endDate: pastDate }),
          createMockModal({ _id: 'modal-3', endDate: null }),
        ];

        const filtered = filterModals(modals, user, counters);

        expect(filtered.map(m => m._id)).toEqual(['modal-1', 'modal-3']);
      });
    });

    describe('forced tag filtering', () => {
      it('returns only modals with matching forced tags', () => {
        const modals: IModal[] = [
          createMockModal({ _id: 'modal-1', tags: ['tag-a'] }),
          createMockModal({ _id: 'modal-2', tags: ['tag-b'] }),
          createMockModal({ _id: 'modal-3', tags: ['tag-a', 'tag-b'] }),
        ];

        const filtered = filterModals(modals, user, counters, ['tag-a']);

        expect(filtered.map(m => m._id)).toEqual(['modal-1', 'modal-3']);
      });

      it('respects enabled flag even with forced tags', () => {
        const modals: IModal[] = [
          createMockModal({ _id: 'modal-1', tags: ['tag-a'], enabled: true }),
          createMockModal({ _id: 'modal-2', tags: ['tag-a'], enabled: false }),
        ];

        const filtered = filterModals(modals, user, counters, ['tag-a']);

        expect(filtered).toHaveLength(1);
        expect(filtered[0]._id).toBe('modal-1');
      });

      it('applies date filters even when forced tags are provided (startDate)', () => {
        const futureDate = new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString();
        const modals: IModal[] = [createMockModal({ _id: 'modal-1', tags: ['tag-a'], startDate: futureDate })];

        const filtered = filterModals(modals, user, counters, ['tag-a']);

        // Date filters should apply even with forced tags - modal with future startDate is filtered out
        expect(filtered).toHaveLength(0);
      });

      it('applies date filters even when forced tags are provided (endDate)', () => {
        const pastDate = new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString(); // Yesterday (expired)
        const modals: IModal[] = [createMockModal({ _id: 'modal-1', tags: ['whats-new'], endDate: pastDate })];

        const filtered = filterModals(modals, user, counters, ['whats-new']);

        // Expired modals should not show in What's New slider or anywhere else
        expect(filtered).toHaveLength(0);
      });

      it('shows valid modals with forced tags when within date bounds', () => {
        const futureDate = new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString(); // Tomorrow
        const pastDate = new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString(); // Yesterday
        const modals: IModal[] = [
          createMockModal({ _id: 'modal-1', tags: ['whats-new'], startDate: pastDate, endDate: futureDate }),
        ];

        const filtered = filterModals(modals, user, counters, ['whats-new']);

        // Valid modal within date bounds should show
        expect(filtered).toHaveLength(1);
        expect(filtered[0]._id).toBe('modal-1');
      });
    });

    describe('behavior-based threshold filtering', () => {
      describe('persistent behavior', () => {
        it('shows modal until user agrees (not yet agreed)', () => {
          const modals: IModal[] = [
            createMockModal({
              _id: 'modal-1',
              numberOfViews: { type: 'persistent', threshold: 999, value: 0 },
              agreeButton: true,
            }),
          ];

          const counters: IUserActivityCounterDocument[] = [createMockCounter('Modal Viewed', 5, ['modal-1'])];

          const filtered = filterModals(modals, user, counters);

          expect(filtered).toHaveLength(1); // Still showing despite 5 views
        });

        it('hides modal after user agrees', () => {
          const modals: IModal[] = [
            createMockModal({
              _id: 'modal-1',
              numberOfViews: { type: 'persistent', threshold: 999, value: 0 },
              agreeButton: true,
            }),
          ];

          const counters: IUserActivityCounterDocument[] = [
            createMockCounter('Modal Viewed', 5, ['modal-1']),
            createMockCounter('Modal Agreed To', 1, ['modal-1']),
          ];

          const filtered = filterModals(modals, user, counters);

          expect(filtered).toHaveLength(0); // Hidden after agree
        });

        it('warns if persistent modal has no agree button', () => {
          const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

          const modals: IModal[] = [
            createMockModal({
              _id: 'modal-1',
              title: 'Test Modal',
              numberOfViews: { type: 'persistent', threshold: 999, value: 0 },
              agreeButton: false,
            }),
          ];

          filterModals(modals, user, counters);

          expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Test Modal'));
          expect(consoleSpy).toHaveBeenCalledWith(
            expect.stringContaining('Persistent behavior but agreeButton is not enabled')
          );

          consoleSpy.mockRestore();
        });
      });

      describe('firstTime behavior', () => {
        it('shows modal if never viewed', () => {
          const modals: IModal[] = [
            createMockModal({
              _id: 'modal-1',
              numberOfViews: { type: 'firstTime', threshold: 1, value: 0 },
            }),
          ];

          const filtered = filterModals(modals, user, []);

          expect(filtered).toHaveLength(1);
        });

        it('hides modal after first view', () => {
          const modals: IModal[] = [
            createMockModal({
              _id: 'modal-1',
              numberOfViews: { type: 'firstTime', threshold: 1, value: 0 },
            }),
          ];

          const counters: IUserActivityCounterDocument[] = [createMockCounter('Modal Viewed', 1, ['modal-1'])];

          const filtered = filterModals(modals, user, counters);

          expect(filtered).toHaveLength(0);
        });
      });

      describe('weekly behavior', () => {
        it('shows modal if never viewed', () => {
          const modals: IModal[] = [
            createMockModal({
              _id: 'modal-1',
              numberOfViews: { type: 'weekly', threshold: 7, value: 0 },
            }),
          ];

          const filtered = filterModals(modals, user, []);

          expect(filtered).toHaveLength(1);
        });

        it('hides modal if viewed within last 7 days', () => {
          const modals: IModal[] = [
            createMockModal({
              _id: 'modal-1',
              numberOfViews: { type: 'weekly', threshold: 7, value: 0 },
            }),
          ];

          const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
          const counters: IUserActivityCounterDocument[] = [
            createMockCounter('Modal Viewed', 1, ['modal-1'], threeDaysAgo),
          ];

          const filtered = filterModals(modals, user, counters);

          expect(filtered).toHaveLength(0);
        });

        it('shows modal if viewed more than 7 days ago', () => {
          const modals: IModal[] = [
            createMockModal({
              _id: 'modal-1',
              numberOfViews: { type: 'weekly', threshold: 7, value: 0 },
            }),
          ];

          const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
          const counters: IUserActivityCounterDocument[] = [
            createMockCounter('Modal Viewed', 1, ['modal-1'], eightDaysAgo),
          ];

          const filtered = filterModals(modals, user, counters);

          expect(filtered).toHaveLength(1);
        });
      });

      describe('custom behavior', () => {
        it('shows modal if below custom threshold', () => {
          const modals: IModal[] = [
            createMockModal({
              _id: 'modal-1',
              numberOfViews: { type: 'custom', threshold: 3, value: 0 },
            }),
          ];

          const counters: IUserActivityCounterDocument[] = [createMockCounter('Modal Viewed', 2, ['modal-1'])];

          const filtered = filterModals(modals, user, counters);

          expect(filtered).toHaveLength(1);
        });

        it('hides modal if at or above custom threshold', () => {
          const modals: IModal[] = [
            createMockModal({
              _id: 'modal-1',
              numberOfViews: { type: 'custom', threshold: 3, value: 0 },
            }),
          ];

          const counters: IUserActivityCounterDocument[] = [createMockCounter('Modal Viewed', 3, ['modal-1'])];

          const filtered = filterModals(modals, user, counters);

          expect(filtered).toHaveLength(0);
        });
      });

      describe('no behavior configured', () => {
        it('shows modal if never viewed (defaults to firstTime)', () => {
          const modals: IModal[] = [
            createMockModal({
              _id: 'no-behavior-never-viewed',
              numberOfViews: null,
            }),
          ];

          const filtered = filterModals(modals, user, counters);

          expect(filtered).toHaveLength(1);
        });

        it('hides modal after first view (defaults to firstTime)', () => {
          const modals: IModal[] = [
            createMockModal({
              _id: 'no-behavior-viewed',
              numberOfViews: null,
            }),
          ];
          const viewedCounters: IUserActivityCounterDocument[] = [
            createMockCounter('Modal Viewed', 1, ['no-behavior-viewed']),
          ];

          const filtered = filterModals(modals, user, viewedCounters);

          expect(filtered).toHaveLength(0);
        });

        it('defaults to firstTime when both numberOfViews and numberOfAgrees are null', () => {
          const modals: IModal[] = [
            createMockModal({
              _id: 'both-null',
              numberOfViews: null,
              numberOfAgrees: null,
            }),
          ];
          const viewedCounters: IUserActivityCounterDocument[] = [createMockCounter('Modal Viewed', 1, ['both-null'])];

          expect(filterModals(modals, user, [])).toHaveLength(1);
          expect(filterModals(modals, user, viewedCounters)).toHaveLength(0);
        });

        it('defaults to firstTime when numberOfAgrees has a non-persistent type (e.g. custom)', () => {
          // Regression vector: if someone later adds `agreeType.startsWith('custom')`
          // logic, this case would break. The implicit default must hold today.
          const modals: IModal[] = [
            createMockModal({
              _id: 'agrees-custom',
              numberOfViews: null,
              numberOfAgrees: { type: 'custom', threshold: 5, value: 0 },
            }),
          ];
          const viewedCounters: IUserActivityCounterDocument[] = [
            createMockCounter('Modal Viewed', 1, ['agrees-custom']),
          ];

          expect(filterModals(modals, user, [])).toHaveLength(1);
          expect(filterModals(modals, user, viewedCounters)).toHaveLength(0);
        });

        it('defaults to firstTime when behavior fields are undefined (not null)', () => {
          const modals: IModal[] = [
            createMockModal({
              _id: 'both-undefined',
              numberOfViews: undefined as unknown as null,
              numberOfAgrees: undefined as unknown as null,
            }),
          ];
          const viewedCounters: IUserActivityCounterDocument[] = [
            createMockCounter('Modal Viewed', 1, ['both-undefined']),
          ];

          expect(filterModals(modals, user, [])).toHaveLength(1);
          expect(filterModals(modals, user, viewedCounters)).toHaveLength(0);
        });
      });
    });

    describe('edge cases', () => {
      it('handles modal without _id', () => {
        const modals: IModal[] = [createMockModal({ _id: undefined })];

        const filtered = filterModals(modals, user, counters);

        expect(filtered).toHaveLength(1); // Modal without ID should show
      });

      it('handles empty modals array', () => {
        const filtered = filterModals([], user, counters);

        expect(filtered).toEqual([]);
      });

      it('handles empty counters array', () => {
        const modals: IModal[] = [
          createMockModal({
            _id: 'modal-1',
            numberOfViews: { type: 'firstTime', threshold: 1, value: 0 },
          }),
        ];

        const filtered = filterModals(modals, user, []);

        expect(filtered).toHaveLength(1); // Should show when no counters
      });
    });
  });

  describe('modalStorage', () => {
    it('stores and retrieves last shown time', () => {
      const modalId = 'test-modal-1';
      const beforeTime = Date.now();

      modalStorage.setLastShownTime(modalId);

      const afterTime = Date.now();
      const storedTime = modalStorage.getLastShownTime(modalId);

      expect(storedTime).toBeGreaterThanOrEqual(beforeTime);
      expect(storedTime).toBeLessThanOrEqual(afterTime);
    });

    it('returns 0 for modal that has never been shown', () => {
      const modalId = 'never-shown-modal';

      const storedTime = modalStorage.getLastShownTime(modalId);

      expect(storedTime).toBe(0);
    });

    it('handles multiple modals independently', async () => {
      modalStorage.setLastShownTime('modal-1');
      await new Promise<void>(resolve =>
        setTimeout(() => {
          modalStorage.setLastShownTime('modal-2');
          resolve();
        }, 10)
      );

      const time1 = modalStorage.getLastShownTime('modal-1');
      const time2 = modalStorage.getLastShownTime('modal-2');

      expect(time1).toBeGreaterThan(0);
      expect(time2).toBeGreaterThanOrEqual(time1);
    });
  });
});
