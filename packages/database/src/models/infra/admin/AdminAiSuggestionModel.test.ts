import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { setupMongoTest } from '../../../__test__/utils';
import {
  AdminAiSuggestionModel,
  adminAiSuggestionRepository,
  type CreatePendingAdminAiSuggestionInput,
} from './AdminAiSuggestionModel';

const pending = (
  overrides: Partial<CreatePendingAdminAiSuggestionInput> = {}
): CreatePendingAdminAiSuggestionInput => ({
  feature: 'abuseAssessment',
  entityType: 'shadowDetection',
  entityId: 'det-1',
  inputHash: 'hash-1',
  policyVersion: '1',
  model: 'test-model',
  verdict: 'abuse',
  confidence: { band: 'high', probability: 0.9 },
  reasons: [{ text: 'many signups from one device', evidenceLinks: ['/admin/detections/det-1'] }],
  costUsd: 0.002,
  latencyMs: 120,
  ...overrides,
});

describe('AdminAiSuggestionRepository', () => {
  setupMongoTest();

  // setupMongoTest drops collections before each test, taking the unique index with them.
  beforeEach(async () => {
    await AdminAiSuggestionModel.syncIndexes();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('dedups on the (feature, entity, input hash, policy version) key', async () => {
    const first = await adminAiSuggestionRepository.createPending(pending());
    const second = await adminAiSuggestionRepository.createPending(pending({ verdict: 'legitimate_automation' }));

    expect(second.id).toBe(first.id);
    expect(second.verdict).toBe('abuse');
    expect(await AdminAiSuggestionModel.countDocuments()).toBe(1);

    const bumped = await adminAiSuggestionRepository.createPending(pending({ policyVersion: '2' }));
    expect(bumped.id).not.toBe(first.id);
    expect(await AdminAiSuggestionModel.countDocuments()).toBe(2);
  });

  it('stores one row when the same key is created concurrently', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => adminAiSuggestionRepository.createPending(pending()))
    );

    expect(new Set(results.map(r => r.id)).size).toBe(1);
    expect(await AdminAiSuggestionModel.countDocuments()).toBe(1);
  });

  it('retries once when the conflicting row is not found on the first read', async () => {
    const first = await adminAiSuggestionRepository.createPending(pending());
    const findByKey = vi.spyOn(adminAiSuggestionRepository, 'findByKey').mockResolvedValueOnce(null);

    const second = await adminAiSuggestionRepository.createPending(pending());

    expect(second.id).toBe(first.id);
    expect(findByKey).toHaveBeenCalledTimes(2);
  });

  it('rethrows the duplicate-key error when the conflicting row is missing on both reads', async () => {
    await adminAiSuggestionRepository.createPending(pending());
    vi.spyOn(adminAiSuggestionRepository, 'findByKey').mockResolvedValue(null);

    await expect(adminAiSuggestionRepository.createPending(pending())).rejects.toMatchObject({ code: 11000 });
  });

  it('round-trips a stored suggestion with model and defaults', async () => {
    const created = await adminAiSuggestionRepository.createPending(pending());
    const found = await adminAiSuggestionRepository.findByKey(pending());

    expect(found).toMatchObject({
      id: created.id,
      model: 'test-model',
      status: 'pending',
      escalated: false,
      proposedAction: null,
      decidedBy: null,
      decidedAt: null,
      overrideReason: null,
      costUsd: 0.002,
      latencyMs: 120,
    });
  });

  it('rejects an unknown status and more than three reasons', async () => {
    await expect(
      AdminAiSuggestionModel.create({ ...pending(), aiModel: 'test-model', status: 'auto' })
    ).rejects.toThrow(/status/);

    const reason = { text: 'r', evidenceLinks: [] };
    await expect(
      adminAiSuggestionRepository.createPending(pending({ reasons: [reason, reason, reason, reason] }))
    ).rejects.toThrow(/at most 3 reasons/);

    const links = ['a', 'b', 'c', 'd', 'e', 'f'];
    await expect(
      adminAiSuggestionRepository.createPending(pending({ reasons: [{ text: 'r', evidenceLinks: links }] }))
    ).rejects.toThrow(/at most 5 evidence links/);
  });

  it('accepts a pending suggestion once; a second accept is stale', async () => {
    const created = await adminAiSuggestionRepository.createPending(pending());
    const decidedBy = { userId: 'admin-1', name: 'Admin' };

    const accepted = await adminAiSuggestionRepository.transition(created.id, ['pending'], 'accepted', { decidedBy });
    expect(accepted).toMatchObject({ status: 'accepted', decidedBy });
    expect(accepted?.decidedAt).toBeInstanceOf(Date);

    await expect(
      adminAiSuggestionRepository.transition(created.id, ['pending'], 'accepted', { decidedBy })
    ).resolves.toBeNull();
  });

  it('returns null for an id that is not an ObjectId or matches no row', async () => {
    await expect(adminAiSuggestionRepository.transition('not-an-id', ['pending'], 'accepted')).resolves.toBeNull();
    await expect(adminAiSuggestionRepository.transition('aaaaaaaaaaaa', ['pending'], 'accepted')).resolves.toBeNull();
    await expect(
      adminAiSuggestionRepository.transition(new Types.ObjectId().toString(), ['pending'], 'accepted')
    ).resolves.toBeNull();
  });

  it('finds the latest suggestion for an entity', async () => {
    await adminAiSuggestionRepository.createPending(pending({ inputHash: 'h1' }));
    const newer = await adminAiSuggestionRepository.createPending(pending({ inputHash: 'h2' }));
    await adminAiSuggestionRepository.createPending(pending({ inputHash: 'h3', entityId: 'det-2' }));

    const latest = await adminAiSuggestionRepository.findLatestForEntity('abuseAssessment', 'det-1');
    expect(latest?.id).toBe(newer.id);
  });
});
