// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AccountProfile, BillingAccount } from '@shared/account';
import type { AccountUsageResult } from '@shared/usage';
import { PROFILE_MIN_GAP_MS, USAGE_MIN_GAP_MS, profileReadDue, usageReadDue } from './refreshGate';
import { useCreditsGlance, type CreditsGlance } from './useCreditsGlance';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PROFILE: AccountProfile = {
  credits: { balance: 4000, monthlyAllowance: 10_000 },
  plan: { name: 'Pro', interval: 'monthly', currentPeriodEndsAt: '2026-12-01T00:00:00Z' },
  tier: 'pro',
};
const USAGE: AccountUsageResult = {
  ok: true,
  usage: {
    window: 'last-30-days',
    granularity: 'day',
    bars: [{ startsAt: '2026-11-23T00:00:00Z', creditsSpent: 200, requests: 3 }],
    creditsSpent: 200,
    requests: 3,
    byModel: [],
    byFeature: [],
    bySource: [],
    readAt: 0,
  },
};

let clock = Date.parse('2026-11-24T00:00:00Z');
const now = () => clock;
const getProfile = vi.fn(async () => PROFILE);
const getHistory = vi.fn(async () => USAGE);
let host: HTMLDivElement;
let root: Root;
let latest: CreditsGlance | null = null;

function Probe({ spentAt, open, payer }: { spentAt: number; open: boolean; payer: BillingAccount | null }) {
  latest = useCreditsGlance(spentAt, open, payer, now);
  return null;
}

async function render(spentAt: number, open = false, payer: BillingAccount | null = null) {
  await act(async () => root.render(<Probe spentAt={spentAt} open={open} payer={payer} />));
}

async function focus() {
  await act(async () => window.dispatchEvent(new Event('focus')));
}

beforeEach(() => {
  clock = Date.parse('2026-11-24T00:00:00Z');
  getProfile.mockClear();
  getHistory.mockClear();
  (window as unknown as { b4m: unknown }).b4m = { account: { getProfile }, usage: { getHistory } };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  latest = null;
});

it('reads once on mount and builds the outlook', async () => {
  await render(0);
  expect(getProfile).toHaveBeenCalledTimes(1);
  expect(getHistory).toHaveBeenCalledTimes(1);
  expect(getHistory).toHaveBeenCalledWith('last-30-days');
  expect(latest?.outlook).toMatchObject({ kind: 'covered', tone: 'ok' });
});

it('collapses a burst of focus events into nothing until the focus gap passes', async () => {
  await render(0);
  for (let i = 0; i < 20; i++) await focus();
  expect(getProfile).toHaveBeenCalledTimes(1);

  clock += PROFILE_MIN_GAP_MS.focus;
  await focus();
  await focus();
  expect(getProfile).toHaveBeenCalledTimes(2);
});

it('re-reads the profile after a settled turn, but not for back-to-back turns', async () => {
  await render(0);
  clock += PROFILE_MIN_GAP_MS.turn;
  await render(1);
  await render(2);
  await render(3);
  expect(getProfile).toHaveBeenCalledTimes(2);
  // The usage history is on its own, longer gap.
  expect(getHistory).toHaveBeenCalledTimes(1);

  clock += USAGE_MIN_GAP_MS;
  await render(4);
  expect(getProfile).toHaveBeenCalledTimes(3);
  expect(getHistory).toHaveBeenCalledTimes(2);
});

it('re-reads when the menu opens once the open gap has passed', async () => {
  await render(0, false);
  await render(0, true);
  expect(getProfile).toHaveBeenCalledTimes(1);
  await render(0, false);
  clock += PROFILE_MIN_GAP_MS.open;
  await render(0, true);
  expect(getProfile).toHaveBeenCalledTimes(2);
});

it('sets no timers', async () => {
  const setTimeoutSpy = vi.spyOn(window, 'setTimeout');
  const setIntervalSpy = vi.spyOn(window, 'setInterval');
  await render(0);
  await focus();
  expect(setIntervalSpy).not.toHaveBeenCalled();
  expect(setTimeoutSpy).not.toHaveBeenCalled();
  setTimeoutSpy.mockRestore();
  setIntervalSpy.mockRestore();
});

it('gates every reason by its own minimum gap', () => {
  expect(profileReadDue('mount', null, 0)).toBe(true);
  expect(profileReadDue('focus', 0, PROFILE_MIN_GAP_MS.focus - 1)).toBe(false);
  expect(profileReadDue('focus', 0, PROFILE_MIN_GAP_MS.focus)).toBe(true);
  expect(profileReadDue('turn', 0, PROFILE_MIN_GAP_MS.turn - 1)).toBe(false);
  expect(profileReadDue('open', 0, PROFILE_MIN_GAP_MS.open)).toBe(true);
  expect(usageReadDue(null, 0)).toBe(true);
  expect(usageReadDue(0, USAGE_MIN_GAP_MS - 1)).toBe(false);
});

it('describes an organization pool by its balance alone, not the personal burn', async () => {
  const acme: BillingAccount = { id: 'org-1', name: 'Acme', personal: false, credits: 7000 };
  await render(0, false, acme);
  expect(latest?.organization).toEqual(acme);
  expect(latest?.burnPerDay).toBeNull();
  expect(latest?.outlook).toEqual({ kind: 'idle', tone: 'ok', ringFill: 0, refillAt: null });

  await render(0, false, { ...acme, credits: 0 });
  expect(latest?.outlook).toMatchObject({ kind: 'empty', tone: 'critical' });

  await render(0, false, { ...acme, credits: null });
  expect(latest?.outlook).toEqual({ kind: 'unknown' });
});

it('keeps the personal outlook when Personal pays', async () => {
  await render(0, false, { id: 'u1', name: 'Personal', personal: true, credits: 4000 });
  expect(latest?.organization).toBeNull();
  expect(latest?.outlook).toMatchObject({ kind: 'covered' });
});
