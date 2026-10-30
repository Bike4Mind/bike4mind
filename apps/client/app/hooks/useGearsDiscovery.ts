import { useEffect, useRef, useState } from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { FirstRunEvents } from '@bike4mind/common';
import type { GearStatus } from '@client/app/hooks/useGearsStatus';
import { useVisibleGears } from '@client/app/hooks/useVisibleGears';
import { useGearCta } from '@client/app/hooks/useGearCta';
import { useUser } from '@client/app/contexts/UserContext';
import { useStreamingState } from '@client/app/hooks/useStreamingState';
import { useLogEvent } from '@client/app/hooks/data/analytics';
import { isAnyModalDialogOpen } from '@client/app/utils/anyDialogOpen';
import { markGearsDiscoveryShown, wasWhatsNewShown } from '@client/app/components/modals/whatsNewSession';
import {
  DISCOVERY_MAX_CARDS,
  DISCOVERY_RECHECK_MS,
  DISCOVERY_SETTLE_MS,
  discoveryCandidates,
  pickDiscoveryGears,
  readDiscoveryState,
  shouldShowDiscovery,
  writeDiscoveryState,
} from '@client/lib/gears/discovery';

export interface GearsDiscovery {
  open: boolean;
  gears: GearStatus[];
  close: () => void;
  dismissForever: () => void;
  seeAll: () => void;
  select: (gear: GearStatus, position: number) => void;
}

/** Decides at most once per page load whether to show the gears discovery modal. Rules: lib/gears/discovery.ts. */
export function useGearsDiscovery(): GearsDiscovery {
  const userId = useUser(s => s.currentUser?.id);
  const { gears, isPending, isError, refetch } = useVisibleGears();
  const isStreaming = useStreamingState(s => s.isAnyStreaming());
  const pathname = useRouterState({ select: s => s.location.pathname });
  const navigate = useNavigate();
  const runCta = useGearCta(() => void refetch());
  const { mutate: logEvent } = useLogEvent();

  const [shown, setShown] = useState<GearStatus[] | null>(null);
  const [settled, setSettled] = useState(false);
  // isAnyModalDialogOpen reads the DOM, which no dependency tracks, so a blocked check is retried on a tick.
  const [tick, setTick] = useState(0);
  const decidedRef = useRef(false);

  useEffect(() => {
    if (isPending) return;
    const t = setTimeout(() => setSettled(true), DISCOVERY_SETTLE_MS);
    return () => clearTimeout(t);
  }, [isPending]);

  useEffect(() => {
    if (decidedRef.current || !settled || !userId || isError) return;
    if (pathname.startsWith('/admin') || pathname.startsWith('/gears')) return;
    if (wasWhatsNewShown()) {
      decidedRef.current = true;
      return;
    }
    if (isStreaming || isAnyModalDialogOpen()) {
      const t = setTimeout(() => setTick(n => n + 1), DISCOVERY_RECHECK_MS);
      return () => clearTimeout(t);
    }

    decidedRef.current = true;
    const now = Date.now();
    const state = readDiscoveryState(userId);
    const candidates = discoveryCandidates(gears);
    if (!shouldShowDiscovery({ state, candidateCount: candidates.length, now })) return;

    const picked = pickDiscoveryGears(candidates, state.rotation);
    writeDiscoveryState(userId, { ...state, lastShownAt: now, rotation: state.rotation + DISCOVERY_MAX_CARDS });
    markGearsDiscoveryShown();
    setShown(picked);
    logEvent({
      type: FirstRunEvents.GEARS_DISCOVERY_SHOWN,
      metadata: { count: picked.length, keys: picked.map(g => g.key).join(',') },
    });
  }, [settled, userId, isError, pathname, isStreaming, tick, gears, logEvent]);

  const dismiss = (how: 'close' | 'never' | 'see_all') => {
    setShown(null);
    logEvent({ type: FirstRunEvents.GEARS_DISCOVERY_DISMISSED, metadata: { how } });
  };

  return {
    open: shown !== null,
    gears: shown ?? [],
    close: () => dismiss('close'),
    dismissForever: () => {
      if (userId) writeDiscoveryState(userId, { ...readDiscoveryState(userId), dismissed: true });
      dismiss('never');
    },
    seeAll: () => {
      dismiss('see_all');
      void navigate({ to: '/gears' });
    },
    select: (gear, position) => {
      setShown(null);
      logEvent({ type: FirstRunEvents.GEARS_DISCOVERY_CLICKED, metadata: { key: gear.key, position } });
      runCta(gear);
    },
  };
}
