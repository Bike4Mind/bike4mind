// apps/client/pages/api/skills/[id]/index.ts
import { Request } from 'express';
import { baseApi } from '@client/server/middlewares/baseApi';
import { skillRepository } from '@bike4mind/database';
import { ApiKeyScope, ISkill } from '@bike4mind/common';
import { NotFoundError, ForbiddenError } from '@bike4mind/utils';
import { applySkillUpdate } from '@server/skills/skillWrite';
import {
  ShareableSkill,
  SkillActor,
  canAccessSkill,
  canEditSkill,
  canDeleteSkill,
  canManageSkillSharing,
  redactShareRosterForViewer,
} from '@server/utils/skillAccess';
import { withdrawSkillListings } from '@bike4mind/server-utils/skillMarket/market';
import { attachMarketStatus } from '@server/skillMarket/marketStatus';

const handler = baseApi({ requiredScopes: [ApiKeyScope.SKILLS_WRITE], grandfatherLegacyKeys: true })
  .get<Request<{}, {}, {}, { id: string }>>(async (req, res) => {
    const { id } = req.query;
    const skill = (await skillRepository.findById(id as string)) as ShareableSkill | null;
    if (!skill) throw new NotFoundError('Skill not found');

    const actor: SkillActor = { id: req.user!.id, isAdmin: req.user!.isAdmin };
    if (!(await canAccessSkill(skill, actor))) {
      throw new ForbiddenError("You don't have permission to view this skill");
    }

    const [withStatus] = await attachMarketStatus([skill]);
    res.json(redactShareRosterForViewer(withStatus, actor.id, await canManageSkillSharing(skill, actor)));
  })
  .put(async (req, res) => {
    const { id } = req.query;
    const body = req.body as Partial<ISkill>;

    const skill = (await skillRepository.findById(id as string)) as ShareableSkill | null;
    if (!skill) throw new NotFoundError('Skill not found');

    // Owner, admin, org-admin, a `update` share, or a globally-writable skill.
    if (!(await canEditSkill(skill, { id: req.user!.id, isAdmin: req.user!.isAdmin }))) {
      throw new ForbiddenError("You don't have permission to update this skill");
    }

    res.json(await applySkillUpdate(skill, body, req, res));
  })
  .delete(async (req, res) => {
    const { id } = req.query;
    const skill = (await skillRepository.findById(id as string)) as ShareableSkill | null;
    if (!skill) throw new NotFoundError('Skill not found');

    if (!(await canDeleteSkill(skill, { id: req.user!.id, isAdmin: req.user!.isAdmin }))) {
      throw new ForbiddenError("You don't have permission to delete this skill");
    }

    await skillRepository.delete(id as string);
    try {
      await withdrawSkillListings(skill.id);
    } catch (err) {
      // The delete is committed; the author can still withdraw from My listings.
      req.logger.error(`Failed to withdraw Skill Market listings for deleted skill ${skill.id}: ${String(err)}`);
    }
    res.status(204).end();
  });

export default handler;
