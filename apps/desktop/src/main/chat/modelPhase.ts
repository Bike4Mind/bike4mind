import type { ModelPhase } from '@shared/chat';

/**
 * Publishes a round's phase only when it changes. The stream calls this on every frame, so a
 * reply of thousands of tokens costs one event per transition rather than one per token.
 */
export function createPhaseTracker(publish: (phase: ModelPhase) => void): (next: ModelPhase) => void {
  let current: string | undefined;
  return next => {
    const key = next.kind === 'writing-tool' ? `${next.kind}:${next.name}` : next.kind;
    if (key === current) return;
    current = key;
    publish(next);
  };
}
