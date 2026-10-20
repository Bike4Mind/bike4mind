import { useEffect, useRef } from 'react';
import { FirstRunEvents, type IChatHistoryItem } from '@bike4mind/common';
import { useLogEvent } from '@client/app/hooks/data/analytics';

const storageKey = (userId: string) => `firstAnswerCreditsLogged:${userId}`;

export function firstAnswerCredits(history: IChatHistoryItem[]): number | null {
  let credits: number | null = null;
  let firstTimestamp = Number.POSITIVE_INFINITY;
  for (const quest of history) {
    if (quest.status !== 'done' || typeof quest.creditsUsed !== 'number') continue;
    const timestamp = new Date(quest.timestamp ?? 0).getTime();
    if (timestamp < firstTimestamp) {
      credits = quest.creditsUsed;
      firstTimestamp = timestamp;
    }
  }
  return credits;
}

export default function FirstAnswerCreditsAnalytics({
  userId,
  history,
}: {
  userId: string | undefined;
  history: IChatHistoryItem[];
}) {
  const { mutateAsync: logEvent } = useLogEvent();
  const inFlightRef = useRef(false);

  useEffect(() => {
    if (!userId || inFlightRef.current) return;
    const credits = firstAnswerCredits(history);
    if (credits === null) return;
    const key = storageKey(userId);
    try {
      if (localStorage.getItem(key) === '1') return;
    } catch {
      // Continue without durable deduplication when browser storage is unavailable.
    }
    inFlightRef.current = true;
    void logEvent({ type: FirstRunEvents.FIRST_ANSWER_CREDITS, metadata: { credits } }).then(response => {
      inFlightRef.current = false;
      if (response === null) return;
      try {
        localStorage.setItem(key, '1');
      } catch {
        // The server write succeeded; storage only prevents a duplicate on a later visit.
      }
    });
  }, [history, userId, logEvent]);

  return null;
}
