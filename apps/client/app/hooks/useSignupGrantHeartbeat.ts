import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { signupGrantRemaining } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { useUser } from '@client/app/contexts/UserContext';
import { useGetSettingsValue } from '@client/app/hooks/data/settings';

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

/**
 * Reports active time to the server while a staged-grant account keeps the app open and in use, so the
 * daily activity drip can pay. Pauses on a hidden tab or after 5 minutes without input, stops once the
 * day is paid, and backs off when the daily budget withholds the credit.
 */
export function useSignupGrantHeartbeat() {
  const { currentUser } = useUser();
  const queryClient = useQueryClient();
  const enabledSetting = useGetSettingsValue('signupGrantActivityEnabled');
  const dailyCredits = Number(useGetSettingsValue('signupGrantActivityDailyCredits')) || 0;
  const grant = currentUser?.signupGrant;
  const today = new Date().toISOString().slice(0, 10);
  const eligible =
    (enabledSetting === true || enabledSetting === 'true') &&
    dailyCredits > 0 &&
    grant?.stage === 'signup' &&
    signupGrantRemaining(grant) > 0 &&
    grant.lastDripDay !== today;
  const userId = currentUser?.id;

  useEffect(() => {
    if (!eligible || !userId) return;
    const tabId = Math.random().toString(36).slice(2);
    let lastInputAt = Date.now();
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
      if (document.hidden || Date.now() - lastInputAt > HEARTBEAT_IDLE_MS || anotherTabLeads(tabId)) {
        schedule(HEARTBEAT_INTERVAL_MS);
        return;
      }
      let delay = HEARTBEAT_INTERVAL_MS;
      try {
        const res = await api.post<HeartbeatResponse>('/api/users/active-session');
        if (res.data.creditsGranted > 0 || res.data.paidToday) {
          queryClient.invalidateQueries({ queryKey: ['user'] });
        }
        if (res.data.paidToday) {
          stopped = true;
          return;
        }
        if (res.data.withheld) delay = HEARTBEAT_BACKOFF_MS;
      } catch {
        // Transient failure: the next tick retries.
      }
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
