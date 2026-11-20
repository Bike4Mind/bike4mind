/**
 * GET  /api/v1/assistant/instructions - the caller's standing instructions.
 * POST /api/v1/assistant/instructions - save one (capped per user).
 * JWT only; every read and write is scoped to `req.user`.
 */
import {
  ASSISTANT_INSTRUCTION_LIMITS,
  BadRequestError,
  INSTRUCTION_LIMIT_REACHED_ERROR_CODE,
  createAssistantInstructionContract,
  listAssistantInstructionsContract,
  type AssistantInstruction,
} from '@bike4mind/common';
import { assistantInstructionRepository, type IAssistantInstruction } from '@bike4mind/database';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { dispatchByMethod } from '@server/middlewares/dispatchByMethod';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';

function serializeInstruction(doc: IAssistantInstruction): AssistantInstruction {
  return { id: doc._id.toString(), text: doc.text, createdAt: doc.createdAt.toISOString() };
}

const listRoute = nextRouteForContract(listAssistantInstructionsContract, {
  rateLimit: perUserRateLimit('GET /api/v1/assistant/instructions'),
  recordsActivity: false,
}).get(async (req, res) => {
  const instructions = await assistantInstructionRepository.listByUser(req.user.id);
  return res.json({ instructions: instructions.map(serializeInstruction) });
});

const createRoute = nextRouteForContract(createAssistantInstructionContract, {
  rateLimit: perUserRateLimit('POST /api/v1/assistant/instructions'),
}).post(async (req, res) => {
  const created = await assistantInstructionRepository.createWithinCap(
    { userId: req.user.id, text: req.validated.text },
    ASSISTANT_INSTRUCTION_LIMITS.perUser
  );
  if (!created) {
    throw new BadRequestError(`You can keep up to ${ASSISTANT_INSTRUCTION_LIMITS.perUser} instructions`, {
      errorCode: INSTRUCTION_LIMIT_REACHED_ERROR_CODE,
    });
  }
  return res.status(201).json(serializeInstruction(created));
});

export const config = {
  api: { externalResolver: true },
};

export default dispatchByMethod({ GET: listRoute, POST: createRoute });
