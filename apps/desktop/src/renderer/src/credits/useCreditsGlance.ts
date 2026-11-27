import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AccountProfile, BillingAccount } from '@shared/account';
import type { UsageBar } from '@shared/usage';
import { creditOutlook, dailyBurn, nextRefillAt, type CreditOutlook } from './creditOutlook';
import { profileReadDue, usageReadDue, type RefreshReason } from './refreshGate';

export interface CreditsGlance {
  profile: AccountProfile | null;
  /**
   * The organization paying instead of the personal ledger, or null for Personal. With one set,
   * `outlook` describes that pool: its balance only, since the personal burn and refill say
   * nothing about it.
   */
  organization: BillingAccount | null;
  outlook: CreditOutlook;
  /** Null until the first usage read lands; the outlook treats that as no known burn. */
  burnPerDay: number | null;
  readAt: number | null;
}

/**
 * The account's balance, refill date and burn rate, for the account strip.
 *
 * Read on mount, when a turn settles (`spentAt` ticks), when the window regains focus, and when
 * the account menu opens - each gated by refreshGate so a burst of any of them is one read.
 * Never on a timer: see useAccountCredits for why a standing poll is not worth it.
 */
export function useCreditsGlance(
  spentAt: number,
  menuOpen: boolean,
  payer: BillingAccount | null = null,
  now: () => number = Date.now
): CreditsGlance {
  const [profile, setProfile] = useState<AccountProfile | null>(null);
  const [bars, setBars] = useState<UsageBar[] | null>(null);
  const [readAt, setReadAt] = useState<number | null>(null);
  const lastProfileRead = useRef<number | null>(null);
  const lastUsageRead = useRef<number | null>(null);
  const mounted = useRef(true);

  const request = useCallback(
    (reason: RefreshReason) => {
      const at = now();
      if (profileReadDue(reason, lastProfileRead.current, at)) {
        lastProfileRead.current = at;
        void window.b4m.account.getProfile().then(next => {
          if (!mounted.current) return;
          setProfile(next);
          setReadAt(now());
        });
      }
      if (usageReadDue(lastUsageRead.current, at)) {
        lastUsageRead.current = at;
        void window.b4m.usage.getHistory('last-30-days').then(result => {
          // A failed read keeps the last good bars: an old rate beats none for a projection.
          if (mounted.current && result.ok) setBars(result.usage.bars);
        });
      }
    },
    [now]
  );

  useEffect(() => {
    mounted.current = true;
    request('mount');
    const onFocus = () => request('focus');
    window.addEventListener('focus', onFocus);
    return () => {
      mounted.current = false;
      window.removeEventListener('focus', onFocus);
    };
  }, [request]);

  const firstSpentAt = useRef(spentAt);
  useEffect(() => {
    if (spentAt !== firstSpentAt.current) request('turn');
  }, [spentAt, request]);

  useEffect(() => {
    if (menuOpen) request('open');
  }, [menuOpen, request]);

  const organization = payer && !payer.personal ? payer : null;
  return useMemo(() => {
    const at = readAt ?? now();
    if (organization) {
      const outlook = creditOutlook({
        balance: organization.credits,
        burnPerDay: 0,
        refillAt: null,
        expiring: undefined,
        now: at,
      });
      return { profile, organization, outlook, burnPerDay: null, readAt };
    }
    const burnPerDay = bars ? dailyBurn(bars, at) : null;
    const outlook = profile
      ? creditOutlook({
          balance: profile.credits.balance,
          burnPerDay: burnPerDay ?? 0,
          refillAt: nextRefillAt(profile.plan, profile.credits.monthlyAllowance, at),
          expiring: profile.credits.expiring,
          now: at,
        })
      : ({ kind: 'unknown' } as const);
    return { profile, organization: null, outlook, burnPerDay, readAt };
  }, [profile, organization, bars, readAt, now]);
}
