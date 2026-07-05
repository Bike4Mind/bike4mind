import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  isModalArchived,
  partitionModals,
  getModalPriorityStatus,
  getStatusChipColor,
  getStatusLabel,
} from '../AdminWhatsNewModalsTab.utils';
import type { IModalDocument } from '@bike4mind/common';

/**
 * Tests for AdminWhatsNewModalsTab utils: expiry status, modal partitioning, and status display.
 */

// Helper to create a mock modal document
function createMockModal(overrides: Partial<IModalDocument> = {}): IModalDocument {
  return {
    _id: 'test-id',
    title: 'Test Modal',
    description: 'Test description',
    enabled: true,
    tags: ['whats-new'],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as IModalDocument;
}

describe('AdminWhatsNewModalsTab.utils', () => {
  // Use fake timers for consistent date testing
  beforeEach(() => {
    vi.useFakeTimers();
    // Set a fixed "now" time for all tests
    vi.setSystemTime(new Date('2026-01-21T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('isModalArchived', () => {
    it('returns true for disabled modals regardless of endDate', () => {
      const modal = createMockModal({ enabled: false, endDate: undefined });
      expect(isModalArchived(modal)).toBe(true);
    });

    it('returns true for disabled modals with future endDate', () => {
      const modal = createMockModal({
        enabled: false,
        endDate: new Date('2026-02-01T00:00:00Z').toISOString(),
      });
      expect(isModalArchived(modal)).toBe(true);
    });

    it('returns true for enabled modals with expired endDate', () => {
      const modal = createMockModal({
        enabled: true,
        endDate: new Date('2026-01-20T00:00:00Z').toISOString(), // yesterday
      });
      expect(isModalArchived(modal)).toBe(true);
    });

    it('returns true for enabled modals that expired just 1 hour ago', () => {
      const modal = createMockModal({
        enabled: true,
        endDate: new Date('2026-01-21T11:00:00Z').toISOString(), // 1 hour ago
      });
      expect(isModalArchived(modal)).toBe(true);
    });

    it('returns false for enabled modals with future endDate', () => {
      const modal = createMockModal({
        enabled: true,
        endDate: new Date('2026-01-25T00:00:00Z').toISOString(), // 4 days from now
      });
      expect(isModalArchived(modal)).toBe(false);
    });

    it('returns false for enabled modals with no endDate', () => {
      const modal = createMockModal({ enabled: true, endDate: undefined });
      expect(isModalArchived(modal)).toBe(false);
    });
  });

  describe('partitionModals', () => {
    it('correctly partitions modals into active and archived', () => {
      const modals = [
        createMockModal({ _id: '1', enabled: true, endDate: undefined }), // active
        createMockModal({ _id: '2', enabled: false, endDate: undefined }), // archived (disabled)
        createMockModal({
          _id: '3',
          enabled: true,
          endDate: new Date('2026-01-20T00:00:00Z').toISOString(),
        }), // archived (expired)
        createMockModal({
          _id: '4',
          enabled: true,
          endDate: new Date('2026-01-25T00:00:00Z').toISOString(),
        }), // active
      ];

      const { active, archived } = partitionModals(modals);

      expect(active).toHaveLength(2);
      expect(archived).toHaveLength(2);
      expect(active.map(m => m._id)).toEqual(['1', '4']);
      expect(archived.map(m => m._id)).toEqual(['2', '3']);
    });

    it('returns empty arrays for empty input', () => {
      const { active, archived } = partitionModals([]);
      expect(active).toHaveLength(0);
      expect(archived).toHaveLength(0);
    });
  });

  describe('getModalPriorityStatus', () => {
    it('returns "expired" for modals with past endDate', () => {
      const modal = createMockModal({
        enabled: true,
        endDate: new Date('2026-01-20T00:00:00Z').toISOString(), // yesterday
      });
      expect(getModalPriorityStatus(modal)).toBe('expired');
    });

    it('returns "expired" for modals that expired 1 hour ago', () => {
      const modal = createMockModal({
        enabled: true,
        endDate: new Date('2026-01-21T11:00:00Z').toISOString(), // 1 hour ago
      });
      expect(getModalPriorityStatus(modal)).toBe('expired');
    });

    it('returns "expired" for modals that expired 1 minute ago', () => {
      const modal = createMockModal({
        enabled: true,
        endDate: new Date('2026-01-21T11:59:00Z').toISOString(), // 1 minute ago
      });
      expect(getModalPriorityStatus(modal)).toBe('expired');
    });

    it('returns "disabled" for disabled modals with no endDate', () => {
      const modal = createMockModal({ enabled: false, endDate: undefined });
      expect(getModalPriorityStatus(modal)).toBe('disabled');
    });

    it('returns "disabled" for disabled modals with future endDate', () => {
      const modal = createMockModal({
        enabled: false,
        endDate: new Date('2026-01-25T00:00:00Z').toISOString(),
      });
      expect(getModalPriorityStatus(modal)).toBe('disabled');
    });

    it('returns "expiring-soon" for enabled modals within 7 days of expiry', () => {
      const modal = createMockModal({
        enabled: true,
        endDate: new Date('2026-01-25T00:00:00Z').toISOString(), // 4 days away
      });
      expect(getModalPriorityStatus(modal)).toBe('expiring-soon');
    });

    it('returns "active" for enabled modals more than 7 days from expiry', () => {
      const modal = createMockModal({
        enabled: true,
        endDate: new Date('2026-02-15T00:00:00Z').toISOString(), // 25 days away
      });
      expect(getModalPriorityStatus(modal)).toBe('active');
    });

    it('returns "active" for enabled modals with no endDate', () => {
      const modal = createMockModal({ enabled: true, endDate: undefined });
      expect(getModalPriorityStatus(modal)).toBe('active');
    });

    // This is the critical bug fix test - "0 days left" should be expired, not expiring-soon
    it('returns "expired" when daysRemaining would round to 0 (the bug fix)', () => {
      // Set time to just after midnight
      vi.setSystemTime(new Date('2026-01-21T00:30:00Z'));

      // Modal expired at midnight (30 minutes ago)
      const modal = createMockModal({
        enabled: true,
        endDate: new Date('2026-01-21T00:00:00Z').toISOString(),
      });

      // Before the fix, Math.ceil(-0.02) = 0, and 0 < 0 is false, so it returned 'expiring-soon'
      // After the fix, 0 <= 0 is true, so it correctly returns 'expired'
      expect(getModalPriorityStatus(modal)).toBe('expired');
    });
  });

  describe('getStatusChipColor', () => {
    it('returns "danger" for expired status', () => {
      expect(getStatusChipColor('expired')).toBe('danger');
    });

    it('returns "neutral" for disabled status', () => {
      expect(getStatusChipColor('disabled')).toBe('neutral');
    });

    it('returns "warning" for expiring-soon status', () => {
      expect(getStatusChipColor('expiring-soon')).toBe('warning');
    });

    it('returns "success" for active status', () => {
      expect(getStatusChipColor('active')).toBe('success');
    });
  });

  describe('getStatusLabel', () => {
    it('returns "Expired" for expired status', () => {
      expect(getStatusLabel('expired')).toBe('Expired');
    });

    it('returns "Disabled" for disabled status', () => {
      expect(getStatusLabel('disabled')).toBe('Disabled');
    });

    it('returns "Expiring Soon" for expiring-soon status', () => {
      expect(getStatusLabel('expiring-soon')).toBe('Expiring Soon');
    });

    it('returns "Active" for active status', () => {
      expect(getStatusLabel('active')).toBe('Active');
    });
  });
});
