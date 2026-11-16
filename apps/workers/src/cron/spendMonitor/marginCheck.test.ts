import { describe, expect, it, vi } from 'vitest';
import type { ISpendRollup } from '@bike4mind/common';
import { buildMarginMessage, findMarginShortfalls, isMarginCheckSlot, runMarginCheck } from './marginCheck';

const CREDIT_USD = 0.0006;
const thresholds = { minRatio: 1, windowHours: 24, costFloorUsd: 5 };

const row = (scopeId: string, costUsd: number, creditsCharged: number, requests = 10): ISpendRollup => ({
  bucketStart: new Date('2026-10-30T00:00:00Z'),
  scopeType: 'model',
  scopeId,
  credits: 0,
  costUsd,
  creditsCharged,
  requests,
});

describe('isMarginCheckSlot', () => {
  it.each([
    ['2026-10-31T00:00:00Z', true],
    ['2026-10-31T00:04:59Z', true],
    ['2026-10-31T00:05:00Z', false],
    ['2026-10-31T23:59:00Z', false],
    ['2026-10-31T12:02:00Z', false],
  ])('%s -> %s', (time, expected) => {
    expect(isMarginCheckSlot(new Date(time))).toBe(expected);
  });
});

describe('findMarginShortfalls', () => {
  it('flags a model charged less than it cost and leaves healthy ones alone', () => {
    // 10_000 credits x 0.0006 = $6 charged against $10 cost; 20_000 credits = $12 against $10 is healthy.
    const findings = findMarginShortfalls(
      [row('cheap-model', 10, 10_000), row('fine-model', 10, 20_000)],
      thresholds,
      CREDIT_USD
    );

    expect(findings).toEqual([
      {
        model: 'cheap-model',
        costUsd: 10,
        creditsCharged: 10_000,
        revenueUsd: expect.closeTo(6),
        ratio: expect.closeTo(0.6),
        requests: 10,
      },
    ]);
  });

  it('flags a model that is above break-even but under a raised ratio', () => {
    const findings = findMarginShortfalls(
      [row('thin-model', 10, 18_000)],
      { ...thresholds, minRatio: 1.2 },
      CREDIT_USD
    );

    expect(findings.map(finding => finding.model)).toEqual(['thin-model']);
    expect(findings[0].ratio).toBeCloseTo(1.08);
  });

  it('skips models under the cost floor, including zero-cost ones', () => {
    const findings = findMarginShortfalls(
      [row('tiny-model', 4.99, 0), row('free-model', 0, 0)],
      thresholds,
      CREDIT_USD
    );

    expect(findings).toEqual([]);
  });

  it('flags a model charged nothing at all', () => {
    const findings = findMarginShortfalls([row('uncharged-model', 8, 0)], thresholds, CREDIT_USD);

    expect(findings).toEqual([expect.objectContaining({ model: 'uncharged-model', revenueUsd: 0, ratio: 0 })]);
  });

  it('orders findings by dollar shortfall, largest first', () => {
    const findings = findMarginShortfalls(
      [row('small-gap', 10, 15_000), row('big-gap', 100, 50_000), row('mid-gap', 20, 10_000)],
      thresholds,
      CREDIT_USD
    );

    expect(findings.map(finding => finding.model)).toEqual(['big-gap', 'mid-gap', 'small-gap']);
  });
});

describe('buildMarginMessage', () => {
  const context = { creditUsd: CREDIT_USD, stage: 'production' };

  it('lists each model with cost, charge, ratio and requests, and totals the shortfall', () => {
    const findings = findMarginShortfalls([row('cheap-model', 10, 10_000, 42)], thresholds, CREDIT_USD);
    const message = JSON.stringify(buildMarginMessage(findings, thresholds, context));

    expect(message).toContain('1 model charged below provider cost');
    expect(message).toContain('cost $10.00, charged $6.00 (10,000 credits), ratio 0.60, 42 requests');
    expect(message).toContain('$4.00');
    expect(message).toContain('Last 24h');
  });

  it('caps the list and counts the rest', () => {
    const rows = Array.from({ length: 18 }, (_, index) => row(`model-${index}`, 10 + index, 0));
    const message = JSON.stringify(
      buildMarginMessage(findMarginShortfalls(rows, thresholds, CREDIT_USD), thresholds, context)
    );

    expect(message).toContain('18 models charged below provider cost');
    expect(message).toContain('+3 more');
  });

  it('escapes model ids', () => {
    const message = JSON.stringify(
      buildMarginMessage(findMarginShortfalls([row('<!channel>', 10, 0)], thresholds, CREDIT_USD), thresholds, context)
    );

    expect(message).not.toContain('<!channel>');
  });
});

describe('runMarginCheck', () => {
  const setup = (rows: ISpendRollup[], latest: Date | null = new Date('2026-10-30T23:55:00Z')) => {
    const sumWindow = vi.fn(async () => new Map(rows.map(item => [item.scopeId, item])));
    const post = vi.fn(async () => {});
    const deps = {
      rollups: { sumWindow, latestBucketStart: vi.fn(async () => latest) },
      post,
      messageContext: { creditUsd: CREDIT_USD, stage: 'production' },
      logger: { log: vi.fn() },
    };
    return { deps, sumWindow, post };
  };

  it('sums the model scope over the window ending at the newest rolled bucket', async () => {
    const { deps, sumWindow } = setup([]);

    await runMarginCheck(deps, thresholds);

    expect(sumWindow).toHaveBeenCalledWith('model', new Date('2026-10-30T00:00:00Z'), new Date('2026-10-31T00:00:00Z'));
  });

  it('posts one digest when any model is short', async () => {
    const { deps, post } = setup([
      row('cheap-model', 10, 10_000),
      row('other-cheap', 20, 0),
      row('fine-model', 10, 20_000),
    ]);

    await expect(runMarginCheck(deps, thresholds)).resolves.toEqual({ checked: 3, flagged: 2 });
    expect(post).toHaveBeenCalledOnce();
  });

  it('posts nothing when every model clears the ratio', async () => {
    const { deps, post } = setup([row('fine-model', 10, 20_000)]);

    await expect(runMarginCheck(deps, thresholds)).resolves.toEqual({ checked: 1, flagged: 0 });
    expect(post).not.toHaveBeenCalled();
  });

  it('does nothing before any bucket has been rolled', async () => {
    const { deps, sumWindow, post } = setup([], null);

    await expect(runMarginCheck(deps, thresholds)).resolves.toEqual({ checked: 0, flagged: 0 });
    expect(sumWindow).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });
});
