/**
 * GET /api/v1/skills/{id} - the public twin of GET /api/skills/[id].
 * PUT /api/v1/skills/{id} - the public twin of PUT /api/skills/[id], taking the text of a SKILL.md.
 */
import { ConflictError, ForbiddenError, NotFoundError, getSkillContract, updateSkillContract } from '@bike4mind/common';
import { skillRepository } from '@bike4mind/database';
import { isValidObjectId } from '@bike4mind/server-utils/utils/objectId';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { dispatchByMethod } from '@server/middlewares/dispatchByMethod';
import { filesFromMap, skillFieldsFromSkillMd } from '@server/skills/skillMdInput';
import { applySkillUpdate } from '@server/skills/skillWrite';
import { toPublicSkill } from '@server/skills/publicView';
import { ShareableSkill, canAccessSkill, canEditSkill } from '@server/utils/skillAccess';
import { validateSkillName } from '@server/utils/skillValidation';
import { publicAppUrl } from '@bike4mind/server-utils/utils/validators';

/** A skill the caller cannot see answers 404 exactly like one that does not exist. */
async function loadVisibleSkill(id: string, actor: { id: string; isAdmin?: boolean }): Promise<ShareableSkill> {
  const skill = isValidObjectId(id) ? ((await skillRepository.findById(id)) as ShareableSkill | null) : null;
  if (!skill || !(await canAccessSkill(skill, actor))) throw new NotFoundError('Skill not found');
  return skill;
}

const getRoute = nextRouteForContract(getSkillContract).get(async (req, res) => {
  const skill = await loadVisibleSkill(req.validatedParams.id, { id: req.user.id, isAdmin: req.user.isAdmin });
  return res.json(toPublicSkill(skill, publicAppUrl(req)));
});

const putRoute = nextRouteForContract(updateSkillContract).put(async (req, res) => {
  const actor = { id: req.user.id, isAdmin: req.user.isAdmin };
  const skill = await loadVisibleSkill(req.validatedParams.id, actor);
  if (!(await canEditSkill(skill, actor))) throw new ForbiddenError("You don't have permission to update this skill");

  const { skill_md, files, allow_rename } = req.validated;
  const { fields, dropped } = skillFieldsFromSkillMd(skill_md, { nameOptional: true });
  if (fields.name !== undefined) validateSkillName(fields.name);
  if (fields.name !== undefined && fields.name.trim() !== skill.name && !allow_rename) {
    throw new ConflictError(
      `This SKILL.md renames the skill from "${skill.name}" to "${fields.name}". ` +
        'Send "allow_rename": true to apply the new name, or change the name back.'
    );
  }

  // A SKILL.md is the whole skill, so what it leaves out is cleared (a cleared hint is unset).
  const updated = await applySkillUpdate(
    skill,
    { ...fields, argumentHint: fields.argumentHint ?? null, ...(files && { files: filesFromMap(files) }) },
    req,
    res,
    name => new ConflictError(`A skill named "${name}" already exists`)
  );
  if (!updated) throw new NotFoundError('Skill not found');
  return res.json({ ...toPublicSkill(updated, publicAppUrl(req)), dropped_fields: dropped });
});

export default dispatchByMethod({ GET: getRoute, PUT: putRoute });

export const config = {
  api: { externalResolver: true },
};
