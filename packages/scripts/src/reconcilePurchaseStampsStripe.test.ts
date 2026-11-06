import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { userRepository } from '@bike4mind/database';
import { createStripeLookups, resolveReportPath } from './reconcilePurchaseStampsStripe';

vi.mock('@bike4mind/database', () => ({ userRepository: { findByStripeCustomerId: vi.fn() } }));

const findByStripeCustomerId = vi.mocked(userRepository.findByStripeCustomerId);

const stubStripe = ({
  intent = {},
  disputes = [],
  retrieveError,
}: {
  intent?: Record<string, unknown>;
  disputes?: { status: string }[];
  retrieveError?: Error;
}) => {
  const retrieve = vi.fn(async () => {
    if (retrieveError) throw retrieveError;
    return { id: 'pi_1', customer: null, latest_charge: { refunded: false }, ...intent };
  });
  const list = vi.fn(async () => ({ data: disputes }));
  const stripe = { paymentIntents: { retrieve }, disputes: { list } };
  return { stripe: stripe as unknown as Parameters<typeof createStripeLookups>[0], retrieve, list };
};

describe('createStripeLookups.classifyPurchase', () => {
  it('reverses a fully refunded charge', async () => {
    const { stripe } = stubStripe({ intent: { latest_charge: { refunded: true } } });
    expect(await createStripeLookups(stripe).classifyPurchase('pi_1')).toEqual({
      kind: 'reversed',
      reason: 'refunded',
    });
  });

  it('keeps a partly refunded charge standing', async () => {
    const { stripe } = stubStripe({ intent: { latest_charge: { refunded: false, amount_refunded: 100 } } });
    expect(await createStripeLookups(stripe).classifyPurchase('pi_1')).toEqual({ kind: 'standing' });
  });

  it('reverses a lost dispute but not a won or open one', async () => {
    const lost = stubStripe({ disputes: [{ status: 'won' }, { status: 'lost' }] });
    const won = stubStripe({ disputes: [{ status: 'won' }, { status: 'needs_response' }] });
    expect(await createStripeLookups(lost.stripe).classifyPurchase('pi_1')).toEqual({
      kind: 'reversed',
      reason: 'dispute_lost',
    });
    expect(await createStripeLookups(won.stripe).classifyPurchase('pi_1')).toEqual({ kind: 'standing' });
    expect(won.list).toHaveBeenCalledWith({ payment_intent: 'pi_1', limit: 100 });
  });

  it('reports a missing intent as unknown instead of throwing', async () => {
    const { stripe } = stubStripe({ retrieveError: new Error('No such payment_intent') });
    expect(await createStripeLookups(stripe).classifyPurchase('pi_1')).toEqual({
      kind: 'unknown',
      error: 'No such payment_intent',
    });
  });
});

describe('createStripeLookups.resolveOwnerByPaymentIntent', () => {
  beforeEach(() => findByStripeCustomerId.mockReset());

  it('resolves the user of a string or expanded customer, retrieving the intent once', async () => {
    findByStripeCustomerId.mockResolvedValue({ id: 'user_1' } as Awaited<ReturnType<typeof findByStripeCustomerId>>);
    const plain = stubStripe({ intent: { customer: 'cus_1' } });
    const lookups = createStripeLookups(plain.stripe);
    await lookups.classifyPurchase('pi_1');
    expect(await lookups.resolveOwnerByPaymentIntent('pi_1')).toBe('user_1');
    expect(plain.retrieve).toHaveBeenCalledTimes(1);

    const expanded = stubStripe({ intent: { customer: { id: 'cus_2' } } });
    expect(await createStripeLookups(expanded.stripe).resolveOwnerByPaymentIntent('pi_1')).toBe('user_1');
    expect(findByStripeCustomerId).toHaveBeenLastCalledWith('cus_2');
  });

  it('returns null for an org customer or no customer', async () => {
    findByStripeCustomerId.mockResolvedValue(null);
    expect(
      await createStripeLookups(stubStripe({ intent: { customer: 'cus_org' } }).stripe).resolveOwnerByPaymentIntent(
        'pi_1'
      )
    ).toBeNull();
    expect(await createStripeLookups(stubStripe({}).stripe).resolveOwnerByPaymentIntent('pi_1')).toBeNull();
  });
});

describe('resolveReportPath', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-report-')));
  const repo = path.join(root, 'repo');
  const outside = path.join(root, 'out');
  fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
  fs.mkdirSync(outside);
  fs.symlinkSync(path.join(repo, 'docs'), path.join(outside, 'link'));

  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('accepts an absolute path outside the repository', () => {
    expect(resolveReportPath(path.join(outside, 'report.json'), repo)).toBe(path.join(outside, 'report.json'));
  });

  it('refuses a path inside the repository, including through a symlink or different case', () => {
    expect(() => resolveReportPath(path.join(repo, 'docs', 'report.json'), repo)).toThrow(/outside the repository/);
    expect(() => resolveReportPath(path.join(outside, 'link', 'report.json'), repo)).toThrow(/outside the repository/);
    expect(() => resolveReportPath(path.join(repo.toUpperCase(), 'r.json'), repo)).toThrow(/outside the repository/);
  });

  it('refuses an empty or relative path', () => {
    expect(() => resolveReportPath('', repo)).toThrow(/absolute path/);
    expect(() => resolveReportPath('report.json', repo)).toThrow(/absolute path/);
  });
});
