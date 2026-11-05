import { useCliStore } from '../store/index.js';

const SESSION_ENDED_NOTE = 'The session that asked for this review has ended.';

/**
 * Answers every prompt a released session left open (permissions denied, questions and review gates cancelled)
 * and empties the queues, so nothing it asked can be answered, or acted on, in the session that replaces it.
 */
export function settlePendingPrompts(): void {
  const {
    permissionPrompt,
    permissionQueue,
    userQuestionPrompt,
    userQuestionQueue,
    reviewGatePrompt,
    reviewGateQueue,
  } = useCliStore.getState();
  useCliStore.setState({
    permissionPrompt: null,
    permissionQueue: [],
    userQuestionPrompt: null,
    userQuestionQueue: [],
    reviewGatePrompt: null,
    reviewGateQueue: [],
  });
  for (const prompt of [permissionPrompt, ...permissionQueue]) prompt?.resolve({ action: 'deny' });
  for (const prompt of [userQuestionPrompt, ...userQuestionQueue]) prompt?.resolve({ answers: [] });
  for (const prompt of [reviewGatePrompt, ...reviewGateQueue]) {
    prompt?.resolve({ decision: 'rejected', note: SESSION_ENDED_NOTE });
  }
}
