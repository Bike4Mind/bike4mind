/**
 * Steering: user input submitted while a turn runs joins that turn at its next
 * model request instead of waiting for the turn to end.
 *
 * Delivery rides the agent's `drainFeedback` hook (see AgentRunOptions), which
 * fires after a tool batch resolves or when the model answers with iterations
 * left, and is never called once the run is aborted. A drain call is therefore
 * the delivery point: the steers leave the queue and enter the session in one
 * synchronous step, so each one is delivered exactly once - to the model and
 * the transcript together - or stays queued for the host to run as a follow-up
 * turn (turnController.ts) or restore to the input on cancel (index.tsx ESC).
 */
import { v4 as uuidv4 } from 'uuid';
import type { Message } from '../storage';
import { useCliStore } from '../store';

const STEER_PREAMBLE =
  'The user sent the following while you were working. Take it into account before you continue, ' +
  'and change course if it asks you to.';

/** The feedback text the model sees for `steers`, or null when there are none. */
export function formatSteerFeedback(steers: string[]): string | null {
  if (steers.length === 0) return null;
  return [STEER_PREAMBLE, ...steers].join('\n\n');
}

/**
 * Take every queued steer and record each as a user message on the session.
 * Returns the feedback for the agent, or null when nothing is queued or the
 * turn was cancelled (the steers then stay queued).
 */
export function deliverSteers(signal: AbortSignal): { feedback: string; steers: string[] } | null {
  if (signal.aborted) return null;
  const store = useCliStore.getState();
  const session = store.session;
  if (!session) return null;

  const steers = store.takeSteerMessages();
  const feedback = formatSteerFeedback(steers);
  if (!feedback) return null;

  const timestamp = new Date().toISOString();
  const steerMessages: Message[] = steers.map(text => ({
    id: uuidv4(),
    role: 'user',
    content: text,
    timestamp,
    metadata: { steered: true },
  }));
  store.setSession({ ...session, messages: [...session.messages, ...steerMessages], updatedAt: timestamp });
  return { feedback, steers };
}
