/**
 * DELETE /api/v1/assistant/instructions/{id} - remove one instruction. JWT only; another user's
 * instruction, or a malformed id, is `404` like a missing one.
 */
import { NotFoundError, deleteAssistantInstructionContract } from '@bike4mind/common';
import { assistantInstructionRepository } from '@bike4mind/database';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';

const route = nextRouteForContract(deleteAssistantInstructionContract, {
  rateLimit: perUserRateLimit('DELETE /api/v1/assistant/instructions/[id]'),
}).delete(async (req, res) => {
  const deleted = await assistantInstructionRepository.deleteOwned(req.user.id, req.validatedParams.id);
  if (!deleted) throw new NotFoundError('Instruction not found');
  return res.status(204).end();
});

export const config = {
  api: { externalResolver: true },
};

export default route;
