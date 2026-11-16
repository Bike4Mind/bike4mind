/**
 * DELETE /api/v1/personas/{id} - hard-delete a test persona minted by POST /api/v1/personas.
 * Same callers as minting (admins and developers, re-checked per call). A caller can delete
 * personas they minted, an admin any persona. Everything else, including an ordinary account,
 * answers 404 like a missing id, so the route can never delete a real user or probe one.
 */
import { PERSONA_ENDPOINT_OFF_CODE, deletePersonaContract } from '@bike4mind/common';
import { userRepository } from '@bike4mind/database';
import { ForbiddenError } from '@bike4mind/server-utils/utils/errors';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import {
  canMintPersonas,
  deletePersonaAccount,
  loadPersonaSettings,
  isPersonaAccount,
  mayManagePersona,
} from '@server/personas/personaAccounts';

const OBJECT_ID_PATTERN = /^[a-f0-9]{24}$/i;

const route = nextRouteForContract(deletePersonaContract, {
  rateLimit: perUserRateLimit('DELETE /api/v1/personas/[id]'),
}).delete(async (req, res) => {
  if (!canMintPersonas(req.user)) throw new ForbiddenError('Only admins and developers can delete test personas');

  if (!(await loadPersonaSettings(req.logger)).enabled) {
    return res.status(404).json({ error: 'Not found', errorCode: PERSONA_ENDPOINT_OFF_CODE });
  }
  const { id } = req.validatedParams;
  const notFound = () => res.status(404).json({ error: 'No persona you can delete has this id' });
  if (!OBJECT_ID_PATTERN.test(id)) return notFound();
  const target = await userRepository.findById(id);
  if (!target || !isPersonaAccount(target) || !mayManagePersona(req.user, target.personaOwnerId)) return notFound();

  await deletePersonaAccount(req, target, 'deleted test persona');
  return res.status(204).end();
});

export const config = {
  api: { externalResolver: true },
};

export default route;
