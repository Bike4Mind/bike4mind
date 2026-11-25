import { describe, it, expect } from 'vitest';
import { CreditHolderType } from '@bike4mind/common';
import { setupMongoTest } from '../../__test__/utils';
import { User, userRepository } from '../auth/UserModel';
import { Organization, organizationRepository } from '../infra/admin/OrganizationModel';
import { CompletionRunModel, completionRunRepository } from './CompletionRunModel';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('CompletionRunModel', () => {
  setupMongoTest();

  it('mints a random UUID bound to the caller and billing owner, and reads it back', async () => {
    const created = await completionRunRepository.create({
      userId: 'user-1',
      ownerType: CreditHolderType.Organization,
      ownerId: 'org-1',
      apiKeyId: 'key-1',
      rootSessionId: 'session-1',
    });

    expect(created.runId).toMatch(UUID);
    expect(created).toMatchObject({
      userId: 'user-1',
      ownerType: CreditHolderType.Organization,
      ownerId: 'org-1',
      apiKeyId: 'key-1',
      rootSessionId: 'session-1',
    });
    expect(created.createdAt).toBeInstanceOf(Date);
    await expect(completionRunRepository.findById(created.runId)).resolves.toEqual(created);
  });

  it('gives every run its own id and leaves unset optional fields off', async () => {
    const owner = { userId: 'user-1', ownerType: CreditHolderType.User, ownerId: 'user-1' } as const;
    const [first, second] = await Promise.all([
      completionRunRepository.create(owner),
      completionRunRepository.create(owner),
    ]);

    expect(first.runId).not.toBe(second.runId);
    expect(first).not.toHaveProperty('apiKeyId');
    expect(first).not.toHaveProperty('rootSessionId');
  });

  it('returns null for an unknown or non-UUID id rather than throwing a cast error', async () => {
    await expect(completionRunRepository.findById('0b6f3c2e-7d4a-4f51-9a8e-2c1d5e6f7a80')).resolves.toBeNull();
    await expect(completionRunRepository.findById('not-a-uuid')).resolves.toBeNull();
  });

  it('keeps the owner binding immutable', async () => {
    const { runId } = await completionRunRepository.create({
      userId: 'user-1',
      ownerType: CreditHolderType.User,
      ownerId: 'user-1',
    });

    await CompletionRunModel.updateOne({ _id: runId }, { $set: { userId: 'user-2', ownerId: 'user-2' } });

    await expect(completionRunRepository.findById(runId)).resolves.toMatchObject({
      userId: 'user-1',
      ownerId: 'user-1',
    });
  });

  describe('run budget', () => {
    it('atomically persists evaluation updates across repository restarts', async () => {
      const run = await completionRunRepository.create({
        userId: 'u',
        ownerType: CreditHolderType.User,
        ownerId: 'u',
        rootSessionId: 'root',
        evaluation: {
          version: 1,
          revision: 0,
          limits: { version: 1, maxProviderUsd: 150, maxTokens: 10000, maxRequests: 100, modelIds: ['model'] },
          committedProviderUsd: 0,
          committedTokens: 0,
          committedRequests: 0,
          receipts: [],
        },
      });
      await Promise.all(
        Array.from({ length: 20 }, () =>
          completionRunRepository.updateEvaluation(run.runId, state => {
            state.committedRequests++;
            return state;
          })
        )
      );
      expect((await completionRunRepository.findById(run.runId))?.evaluation?.committedRequests).toBe(20);
    });
    it('mints the same evaluation atomically on concurrent retries and never resets its limits or spend', async () => {
      const input = {
        userId: 'u',
        ownerType: CreditHolderType.User as const,
        ownerId: 'u',
        rootSessionId: 'recovery-root',
        evaluation: {
          version: 1 as const,
          revision: 0,
          limits: { version: 1 as const, maxProviderUsd: 150, maxTokens: 10000, maxRequests: 100, modelIds: ['model'] },
          committedProviderUsd: 0,
          committedTokens: 0,
          committedRequests: 0,
          receipts: [],
        },
      };
      const runs = await Promise.all(Array.from({ length: 10 }, () => completionRunRepository.create(input)));
      expect(new Set(runs.map(run => run.runId)).size).toBe(1);
      await completionRunRepository.updateEvaluation(runs[0].runId, state => ({
        ...state,
        committedRequests: 1,
        committedProviderUsd: 2,
      }));
      expect((await completionRunRepository.create(input)).evaluation).toMatchObject({
        committedRequests: 1,
        committedProviderUsd: 2,
      });
      await expect(
        completionRunRepository.create({
          ...input,
          evaluation: { ...input.evaluation, limits: { ...input.evaluation.limits, maxProviderUsd: 149 } },
        })
      ).rejects.toMatchObject({
        message: expect.stringContaining('different policy'),
        additionalInfo: { errorCode: 'evaluation_identity_conflict' },
      });
    });
    const owner = { userId: 'user-1', ownerType: CreditHolderType.User, ownerId: 'user-1' } as const;

    it('records a budget with nothing committed, and no counter for a run without one', async () => {
      const budgeted = await completionRunRepository.create({ ...owner, budgetCredits: 500 });
      const unbudgeted = await completionRunRepository.create(owner);

      expect(budgeted).toMatchObject({ budgetCredits: 500, committedCredits: 0 });
      expect(unbudgeted).not.toHaveProperty('budgetCredits');
      expect(unbudgeted).not.toHaveProperty('committedCredits');
      await expect(completionRunRepository.claimBudget(unbudgeted.runId, 100, 10)).resolves.toEqual({
        kind: 'unbudgeted',
      });
    });

    it('never lets concurrent claims together exceed the budget', async () => {
      const { runId } = await completionRunRepository.create({ ...owner, budgetCredits: 1000 });

      const outcomes = await Promise.all(
        Array.from({ length: 25 }, () => completionRunRepository.claimBudget(runId, 120, 30))
      );

      const claimed = outcomes.flatMap(outcome => (outcome.kind === 'claimed' ? [outcome.credits] : []));
      const total = claimed.reduce((sum, credits) => sum + credits, 0);
      expect(total).toBeLessThanOrEqual(1000);
      // Eight full claims fit; the last 40 credits still cover a short answer.
      expect(total).toBe(1000);
      expect(claimed.every(credits => credits >= 30)).toBe(true);
      expect(outcomes.filter(outcome => outcome.kind === 'exhausted')).toHaveLength(25 - claimed.length);
      await expect(completionRunRepository.findById(runId)).resolves.toMatchObject({ committedCredits: 1000 });
    });

    it('claims what is left when it covers the minimum, and refuses below it', async () => {
      const { runId } = await completionRunRepository.create({ ...owner, budgetCredits: 100 });

      await expect(completionRunRepository.claimBudget(runId, 80, 10)).resolves.toEqual({
        kind: 'claimed',
        credits: 80,
      });
      await expect(completionRunRepository.claimBudget(runId, 80, 10)).resolves.toEqual({
        kind: 'claimed',
        credits: 20,
      });
      await expect(completionRunRepository.claimBudget(runId, 80, 10)).resolves.toEqual({
        kind: 'exhausted',
        budgetCredits: 100,
        committedCredits: 100,
      });
    });

    it('caps what a claim takes above its minimum at its share of the rest', async () => {
      const { runId } = await completionRunRepository.create({ ...owner, budgetCredits: 251 });

      // A parent sized to its full output budget no longer takes the whole run, so a worker still fits:
      // 20 + half of the other 231.
      await expect(completionRunRepository.claimBudget(runId, 251, 20, 0.5)).resolves.toEqual({
        kind: 'claimed',
        credits: 136,
      });
      await expect(completionRunRepository.claimBudget(runId, 200, 20, 0.5)).resolves.toEqual({
        kind: 'claimed',
        credits: 68,
      });
      // A claim smaller than its share is taken whole.
      await expect(completionRunRepository.claimBudget(runId, 30, 20, 0.5)).resolves.toEqual({
        kind: 'claimed',
        credits: 30,
      });
      await expect(completionRunRepository.claimBudget(runId, 100, 20, 0.5)).resolves.toMatchObject({
        kind: 'exhausted',
        committedCredits: 234,
      });
    });

    it('shares only the headroom past a large minimum, so a long-context round keeps its output room', async () => {
      const { runId } = await completionRunRepository.create({ ...owner, budgetCredits: 500 });

      // Halving the whole 500 would leave this round no more than its 263 minimum.
      await expect(completionRunRepository.claimBudget(runId, 1850, 263, 0.5)).resolves.toEqual({
        kind: 'claimed',
        credits: 382,
      });
      // A top-up asks for no minimum: the share then applies to all that is left.
      await expect(completionRunRepository.claimBudget(runId, 1850, 0, 0.5)).resolves.toEqual({
        kind: 'claimed',
        credits: 59,
      });
    });

    it('rejects a share outside (0, 1]', async () => {
      const { runId } = await completionRunRepository.create({ ...owner, budgetCredits: 100 });

      await expect(completionRunRepository.claimBudget(runId, 50, 10, 0)).rejects.toThrow('maxShareOfRemaining');
      await expect(completionRunRepository.claimBudget(runId, 50, 10, 1.5)).rejects.toThrow('maxShareOfRemaining');
      await expect(completionRunRepository.findById(runId)).resolves.toMatchObject({ committedCredits: 0 });
    });

    it('releases the unused part of a claim on settlement and the whole claim on a refund', async () => {
      const { runId } = await completionRunRepository.create({ ...owner, budgetCredits: 100 });
      await completionRunRepository.claimBudget(runId, 60, 10);
      await completionRunRepository.claimBudget(runId, 40, 10);

      await completionRunRepository.releaseClaim({ runId, credits: 60 }, 25);
      await completionRunRepository.releaseClaim({ runId, credits: 40 }, 0);

      await expect(completionRunRepository.findById(runId)).resolves.toMatchObject({ committedCredits: 25 });
      await expect(completionRunRepository.claimBudget(runId, 100, 10)).resolves.toEqual({
        kind: 'claimed',
        credits: 75,
      });
    });

    it('only ever raises a budget, and never adds one to a run minted without', async () => {
      const budgeted = await completionRunRepository.create({ ...owner, budgetCredits: 100 });
      const unbudgeted = await completionRunRepository.create(owner);
      await completionRunRepository.claimBudget(budgeted.runId, 100, 10);

      await expect(completionRunRepository.raiseBudget(budgeted.runId, 100)).resolves.toEqual({
        kind: 'not_higher',
        budgetCredits: 100,
      });
      await expect(completionRunRepository.raiseBudget(unbudgeted.runId, 100)).resolves.toEqual({ kind: 'unbudgeted' });

      const raised = await completionRunRepository.raiseBudget(budgeted.runId, 150);
      expect(raised).toMatchObject({ kind: 'raised', run: { budgetCredits: 150, committedCredits: 100 } });
      await expect(completionRunRepository.claimBudget(budgeted.runId, 100, 10)).resolves.toEqual({
        kind: 'claimed',
        credits: 50,
      });
    });

    it("never changes a run's budget by minting another under a different or repeated root session", async () => {
      const run = await completionRunRepository.create({ ...owner, rootSessionId: 'root-a', budgetCredits: 100 });
      await completionRunRepository.claimBudget(run.runId, 60, 10);

      const others = await Promise.all([
        completionRunRepository.create({ ...owner, rootSessionId: 'root-b', budgetCredits: 10_000 }),
        completionRunRepository.create({ ...owner, rootSessionId: 'root-a', budgetCredits: 10_000 }),
      ]);

      expect(others.map(other => other.runId)).not.toContain(run.runId);
      await expect(completionRunRepository.findById(run.runId)).resolves.toMatchObject({
        budgetCredits: 100,
        committedCredits: 60,
      });
    });

    it("leaves a run's budget and committed credits unchanged when the owner's balance is topped up", async () => {
      const user = await User.create({
        username: 'payer',
        name: 'Payer',
        email: 'payer@example.com',
        currentCredits: 10,
        tokenVersion: 0,
      });
      const org = await Organization.create({ name: 'Payer Org', userId: user.id, users: [], groups: [] });
      const personal = { userId: user.id, ownerType: CreditHolderType.User, ownerId: user.id } as const;
      const pooled = { userId: user.id, ownerType: CreditHolderType.Organization, ownerId: org.id } as const;
      const personalRun = await completionRunRepository.create({ ...personal, budgetCredits: 100 });
      const orgRun = await completionRunRepository.create({ ...pooled, budgetCredits: 100 });
      for (const { runId } of [personalRun, orgRun]) {
        await completionRunRepository.claimBudget(runId, 100, 10);
      }

      await userRepository.incrementCredits(user.id, 50_000, { updateLastCreditsPurchasedAt: true });
      await organizationRepository.incrementCredits(org.id, 50_000);

      for (const { runId } of [personalRun, orgRun]) {
        await expect(completionRunRepository.findById(runId)).resolves.toMatchObject({
          budgetCredits: 100,
          committedCredits: 100,
        });
        await expect(completionRunRepository.claimBudget(runId, 10, 1)).resolves.toEqual({
          kind: 'exhausted',
          budgetCredits: 100,
          committedCredits: 100,
        });
      }
    });
  });
});
