import { describe, expect, it, vi } from 'vitest';
import { CreditHolderType, type ShadowDetectionItem } from '@bike4mind/common';
import type { UserLinkState } from '@bike4mind/database';
import {
  DETECTION_LINK_ACCOUNT_LIMIT,
  findDetectionLinkedAccounts,
  type DetectionLinkDeps,
} from './detectionLinkedAccounts';

const SUBJECT = 'a'.repeat(24);
const LINKED_ONE = 'b'.repeat(24);
const LINKED_TWO = 'c'.repeat(24);
const NOW = new Date('2026-11-09T00:00:00Z');

const detection = (overrides: Partial<ShadowDetectionItem>): ShadowDetectionItem => ({
  id: 'd1',
  detector: 'accountCampaign',
  policyVersion: 1,
  wouldAction: 'suspend',
  summary: '3 accounts linked on network and lifecycle',
  userIds: [SUBJECT],
  network: null,
  signals: [],
  windowMinutes: null,
  group: null,
  payment: null,
  detectedAt: new Date('2026-11-08T00:00:00Z'),
  verdict: null,
  verdicts: [],
  revision: 0,
  ...overrides,
});

const state = (id: string, overrides: Partial<UserLinkState> = {}): UserLinkState => ({
  id,
  name: `Account ${id.slice(0, 1)}`,
  email: `${id.slice(0, 1)}@example.com`,
  createdAt: new Date('2026-11-07T00:00:00Z'),
  isBanned: false,
  disputePending: false,
  moderation: null,
  currentCredits: 500,
  ...overrides,
});

function deps(overrides: Partial<DetectionLinkDeps> = {}): DetectionLinkDeps {
  return {
    listDetections: vi.fn().mockResolvedValue({ data: [], truncated: false }),
    findLinkStates: vi.fn(async (ids: string[]) => ids.map(id => state(id))),
    aiSpendSince: vi.fn().mockResolvedValue({}),
    countActiveApiKeys: vi.fn().mockResolvedValue({}),
    now: () => NOW,
    ...overrides,
  };
}

describe('findDetectionLinkedAccounts', () => {
  it('returns nothing to act on when no cohort detection names the user', async () => {
    const result = await findDetectionLinkedAccounts(SUBJECT, deps());
    expect(result).toEqual({ detections: [], accounts: [], truncated: false });
  });

  it('lists the other accounts each cohort detection names, with spend, balance and live keys', async () => {
    const options = deps({
      listDetections: vi.fn().mockResolvedValue({
        data: [
          detection({ id: 'campaign', userIds: [SUBJECT, LINKED_ONE, LINKED_TWO] }),
          detection({ id: 'burst', detector: 'signupNetworkBurst', userIds: [SUBJECT, LINKED_ONE] }),
        ],
        truncated: false,
      }),
      findLinkStates: vi.fn(async (ids: string[]) =>
        ids.map(id => state(id, id === LINKED_TWO ? { isBanned: true, currentCredits: 0 } : {}))
      ),
      aiSpendSince: vi.fn().mockResolvedValue({ [LINKED_ONE]: 1200 }),
      countActiveApiKeys: vi.fn().mockResolvedValue({ [LINKED_ONE]: 2 }),
    });

    const result = await findDetectionLinkedAccounts(SUBJECT, options);

    expect(options.listDetections).toHaveBeenCalledWith(SUBJECT, {
      detectors: ['accountCampaign', 'signupNetworkBurst', 'signupIpLinkedToBlocked'],
      limit: expect.any(Number),
    });
    expect(options.aiSpendSince).toHaveBeenCalledWith(
      [LINKED_ONE, LINKED_TWO],
      CreditHolderType.User,
      new Date('2026-10-10T00:00:00Z')
    );
    expect(result.detections).toEqual([
      expect.objectContaining({ id: 'campaign', detector: 'accountCampaign', accountCount: 3, verdict: null }),
      expect.objectContaining({ id: 'burst', detector: 'signupNetworkBurst', accountCount: 2 }),
    ]);
    expect(result.accounts).toEqual([
      expect.objectContaining({
        id: LINKED_ONE,
        spent: 1200,
        balance: 500,
        activeApiKeys: 2,
        blocked: false,
        detectionIds: ['campaign', 'burst'],
      }),
      expect.objectContaining({
        id: LINKED_TWO,
        spent: 0,
        balance: 0,
        activeApiKeys: 0,
        blocked: true,
        isBanned: true,
      }),
    ]);
    expect(result.accounts.some(account => account.id === SUBJECT)).toBe(false);
  });

  it('caps the accounts it reads and says so', async () => {
    const many = Array.from({ length: DETECTION_LINK_ACCOUNT_LIMIT + 5 }, (_, index) =>
      index.toString(16).padStart(24, '0')
    );
    const options = deps({
      listDetections: vi
        .fn()
        .mockResolvedValue({ data: [detection({ userIds: [SUBJECT, ...many] })], truncated: false }),
    });

    const result = await findDetectionLinkedAccounts(SUBJECT, options);

    expect(result.accounts).toHaveLength(DETECTION_LINK_ACCOUNT_LIMIT);
    expect(result.truncated).toBe(true);
  });
});
