import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { signupGrantDripOpen, signupGrantDripRemaining } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { useUser } from '@client/app/contexts/UserContext';
import { useSignupGrantSchedule } from '@client/app/hooks/useSignupGrantSchedule';

// Cadence must stay within the server's MIN_GAP_MS / MAX_CREDIT_MS in server/credits/recordActiveSession.ts.
export const HEARTBEAT_INTERVAL_MS = 60_000;
export const HEARTBEAT_BACKOFF_MS = 5 * 60_000;
export const HEARTBEAT_IDLE_MS = 5 * 60_000;
const LEADER_KEY = 'b4m-signup-heartbeat-leader';
const LEADER_TTL_MS = 90_000;
const INPUT_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'scroll', 'wheel', 'touchstart'] as const;

interface HeartbeatResponse {
  creditsGranted: number;
  paidToday: boolean;
  withheld: boolean;
  nextEligibleAt?: number;
}

/** Another tab pinged recently, so this one idles; the server throttle remains the real guard. */
function anotherTabLeads(tabId: string): boolean {
  try {
    const raw = localStorage.getItem(LEADER_KEY);
    const leader = raw ? (JSON.parse(raw) as { id: string; at: number }) : null;
    if (leader && leader.id !== tabId && Date.now() - leader.at < LEADER_TTL_MS) return true;
    localStorage.setItem(LEADER_KEY, JSON.stringify({ id: tabId, at: Date.now() }));
  } catch {
    // Storage unavailable: ping anyway.
  }
  return false;
}

/** Reports active time while a staged-grant account has the app open and in use, so the daily drip can pay. */
export function useSignupGrantHeartbeat() {
  const { currentUser } = useUser();
  const queryClient = useQueryClient();
  const { dailyCredits, dripCap } = useSignupGrantSchedule();
  const grant = currentUser?.signupGrant;
  const eligible =
    dailyCredits > 0 && !!grant && signupGrantDripOpen(grant) && signupGrantDripRemaining(grant, dripCap) > 0;
  const userId = currentUser?.id;

  useEffect(() => {
    if (!eligible || !userId) return;
    const tabId = Math.random().toString(36).slice(2);
    let lastInputAt = 0;
    let paidUntil = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const onInput = () => {
      lastInputAt = Date.now();
    };
    INPUT_EVENTS.forEach(name => window.addEventListener(name, onInput, { passive: true }));

    const schedule = (delay: number) => {
      if (!stopped) timer = setTimeout(tick, delay);
    };
    const tick = async () => {
      if (Date.now() < paidUntil) {
        schedule(HEARTBEAT_INTERVAL_MS);
        return;
      }
      if (document.hidden || Date.now() - lastInputAt > HEARTBEAT_IDLE_MS || anotherTabLeads(tabId)) {
        schedule(HEARTBEAT_INTERVAL_MS);
        return;
      }
      let delay = HEARTBEAT_INTERVAL_MS;
      try {
        const res = await api.post<HeartbeatResponse>('/api/users/active-session');
        if (res.data.creditsGranted > 0 || res.data.paidToday) {
          queryClient.invalidateQueries({ queryKey: ['identify'] });
        }
        if (res.data.paidToday) {
          const nextUtcDay = new Date().setUTCHours(24, 0, 0, 0);
          const nextEligibleAt = res.data.nextEligibleAt;
          paidUntil =
            typeof nextEligibleAt === 'number' && Number.isFinite(nextEligibleAt) && nextEligibleAt > Date.now()
              ? nextEligibleAt
              : nextUtcDay;
          schedule(HEARTBEAT_INTERVAL_MS);
          return;
        }
        if (res.data.withheld) delay = HEARTBEAT_BACKOFF_MS;
      } catch {}
      schedule(delay);
    };
    tick();

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      INPUT_EVENTS.forEach(name => window.removeEventListener(name, onInput));
    };
  }, [eligible, userId, queryClient]);
}
