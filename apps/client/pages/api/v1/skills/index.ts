/** POST /api/v1/skills - the public twin of POST /api/skills, taking the text of a SKILL.md. */
import { createSkillContract, ConflictError, NotFoundError } from '@bike4mind/common';
import { isValidObjectId } from '@bike4mind/server-utils/utils/objectId';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { filesFromMap, skillFieldsFromSkillMd } from '@server/skills/skillMdInput';
import { insertSkill, resolveCreateScope, validateNewSkill } from '@server/skills/skillWrite';
import { toPublicSkill } from '@server/skills/publicView';
import { publicAppUrl } from '@server/utils/validators';

const handler = nextRouteForContract(createSkillContract).post(async (req, res) => {
  const { skill_md, files, scope } = req.validated;
  const { fields, dropped } = skillFieldsFromSkillMd(skill_md);
  const content = validateNewSkill({ ...fields, ...(files && { files: filesFromMap(files) }) });

  // A malformed organization id names an organization that cannot exist (CONVENTIONS.md status table).
  if (scope && !isValidObjectId(scope.organization_id)) throw new NotFoundError('Organization not found');
  const target = await resolveCreateScope(
    { scope: scope && { organizationId: scope.organization_id } },
    { id: req.user.id, isAdmin: Boolean(req.user.isAdmin) }
  );

  const created = await insertSkill(
    content,
    target,
    name => new ConflictError(`A skill named "${name}" already exists`)
  );
  return res.status(201).json({ ...toPublicSkill(created, publicAppUrl(req)), dropped_fields: dropped });
});

export default handler;

export const config = {
  api: { externalResolver: true },
};
