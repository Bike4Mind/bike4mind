import { z } from 'zod';
import { defineEndpoint } from '../defineEndpoint';
import { InterruptionFeedbackSchema } from '../../schemas/pushNotification';
import { ApiErrorSchema } from '../../schemas/chat';

const InterruptionFeedbackResponseSchema = z.object({ feedback: InterruptionFeedbackSchema });

const INTERRUPTION_FEEDBACK_NOTE =
  "Authenticate with a JWT access token of the signed-in user. The feedback is the caller's own. `true` for a " +
  'category means the push sent when a busy block ends stays quiet when that category is all the brief ' +
  'reports; the brief is still listed. If no brief is composed for the block, the run summary push still goes ' +
  'out. A decision or any other content always pushes.';

const INTERRUPTION_FEEDBACK_EXAMPLE = { agent_completed: true };

/**
 * What the user taught the block-end brief push to stay quiet about. Served by
 * apps/client/pages/api/v1/assistant/interruptions.ts; read at push time in apps/workers/src/events/sendPush.ts.
 */
export const getInterruptionFeedbackContract = /* @__PURE__ */ defineEndpoint({
  method: 'get',
  path: '/api/v1/assistant/interruptions',
  operationId: 'getInterruptionFeedback',
  summary: 'Get your interruption feedback',
  description: 'Reads which categories stay quiet after a busy block ends. ' + INTERRUPTION_FEEDBACK_NOTE,
  tags: ['AI'],
  auth: 'jwtOnly',
  responses: {
    200: { description: 'Your interruption feedback.', schema: InterruptionFeedbackResponseSchema },
    401: { description: 'Missing or invalid JWT.', schema: ApiErrorSchema },
    429: { description: 'Per-user rate limit exceeded.', schema: ApiErrorSchema },
  },
  codeSample: { authToken: '<access_token>', streaming: false },
});

export const putInterruptionFeedbackContract = /* @__PURE__ */ defineEndpoint({
  method: 'put',
  path: '/api/v1/assistant/interruptions',
  operationId: 'setInterruptionFeedback',
  summary: 'Set your interruption feedback',
  description:
    'Updates the categories present in the body and leaves the others as they were, then returns the stored ' +
    'feedback. ' +
    INTERRUPTION_FEEDBACK_NOTE,
  tags: ['AI'],
  auth: 'jwtOnly',
  request: InterruptionFeedbackSchema,
  requestExample: INTERRUPTION_FEEDBACK_EXAMPLE,
  responses: {
    200: { description: 'The stored interruption feedback.', schema: InterruptionFeedbackResponseSchema },
    400: { description: 'Malformed JSON body.', schema: ApiErrorSchema },
    401: { description: 'Missing or invalid JWT.', schema: ApiErrorSchema },
    422: { description: 'Unknown category or non-boolean value.', schema: ApiErrorSchema },
    429: { description: 'Per-user rate limit exceeded.', schema: ApiErrorSchema },
  },
  codeSample: { authToken: '<access_token>', body: INTERRUPTION_FEEDBACK_EXAMPLE, streaming: false },
});
