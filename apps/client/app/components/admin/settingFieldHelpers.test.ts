import { describe, it, expect } from 'vitest';
import { creditsToUsdAtFloor, formatUsdAmount } from '@bike4mind/common';
import { describeMoneyValue, moneyChangeWarning } from './settingFieldHelpers';

// The floor rate is derived from env-tunable constants, so expected dollars are computed, not hardcoded.
const usdAtFloor = (credits: number) => formatUsdAmount(creditsToUsdAtFloor(credits));

describe('describeMoneyValue', () => {
  it('reads a price per credit as dollars per credit', () => {
    expect(describeMoneyValue('pricePerCredit', 60)).toBe('60 ($60 per credit)');
  });

  it('values credit amounts at the floor credit price', () => {
    expect(describeMoneyValue('teamPlanCreditsPerSeat', 1000)).toBe(
      `1000 (${usdAtFloor(1000)} per seat at the floor credit price)`
    );
    expect(describeMoneyValue('SimulatorComputeCreditsPerRound', 50)).toBe(
      `50 (${usdAtFloor(50)} per round at the floor credit price)`
    );
    expect(describeMoneyValue('HardwareComputeCreditsPerUsd', 2000)).toBe(
      `2000 (${usdAtFloor(2000)} per $1 of hardware cost at the floor credit price)`
    );
  });

  it('leaves seat counts and switches without a dollar figure', () => {
    expect(describeMoneyValue('teamPlanMinSeats', 3)).toBe('3');
    expect(describeMoneyValue('enforceCredits', true)).toBe('on');
  });

  it('does not price an unset or unparseable value as $0', () => {
    expect(describeMoneyValue('pricePerCredit', '')).toBe('unset');
    expect(describeMoneyValue('pricePerCredit', null)).toBe('unset');
    expect(describeMoneyValue('teamPlanCreditsPerSeat', 'abc')).toBe('abc');
  });
});

describe('moneyChangeWarning', () => {
  it('states both sides of the change with their dollar values', () => {
    expect(moneyChangeWarning('pricePerCredit', 'Price Per Credit', 50, 60)).toBe(
      'Price Per Credit changes what customers pay: 50 ($50 per credit) to 60 ($60 per credit).'
    );
  });
});
