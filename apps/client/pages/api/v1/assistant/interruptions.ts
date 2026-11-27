/**
 * GET /api/v1/assistant/interruptions - the caller's block-end push feedback.
 * PUT /api/v1/assistant/interruptions - update the categories present in the body.
 * JWT only; reads and writes only `req.user`.
 */
import { getInterruptionFeedbackContract, putInterruptionFeedbackContract } from '@bike4mind/common';
import { userRepository } from '@bike4mind/database';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { dispatchByMethod } from '@server/middlewares/dispatchByMethod';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';

const getRoute = nextRouteForContract(getInterruptionFeedbackContract, {
  rateLimit: perUserRateLimit('GET /api/v1/assistant/interruptions'),
  recordsActivity: false,
}).get(async (req, res) => {
  return res.json({ feedback: await userRepository.getInterruptionFeedback(req.user.id) });
});

const putRoute = nextRouteForContract(putInterruptionFeedbackContract, {
  rateLimit: perUserRateLimit('PUT /api/v1/assistant/interruptions'),
}).put(async (req, res) => {
  return res.json({ feedback: await userRepository.setInterruptionFeedback(req.user.id, req.validated) });
});

export const config = {
  api: { externalResolver: true },
};

export default dispatchByMethod({ GET: getRoute, PUT: putRoute });
