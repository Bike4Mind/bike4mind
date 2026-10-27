// apps/client/pages/api/skills/[id]/index.ts
import { Request } from 'express';
import { baseApi } from '@client/server/middlewares/baseApi';
import { skillRepository } from '@bike4mind/database';
import { ISkill } from '@bike4mind/common';
import type { RepositoryUpdateOptions } from '@bike4mind/common';
import { NotFoundError, ForbiddenError, BadRequestError } from '@bike4mind/utils';
import {
  validateSkillName,
  validateSkillDescription,
  validateSkillBody,
  validateSkillArgumentHint,
  validateSkillAllowedTools,
  validateSkillFiles,
  validateSkillClaudeCodeAllowedTools,
} from '@server/utils/skillValidation';
import { isDuplicateKeyError } from '@bike4mind/server-utils/utils/isDuplicateKeyError';
import {
  ShareableSkill,
  SkillActor,
  canAccessSkill,
  canEditSkill,
  globalSkillScanFor,
  canDeleteSkill,
  canManageSkillSharing,
  redactShareRosterForViewer,
} from '@server/utils/skillAccess';
import { attachMarketStatus } from '@server/skillMarket/marketStatus';
import { scanGlobalSkillUpdate } from '@server/skillMarket/globalSkillUpdate';
import { getOperationsClassifierLlm } from '@server/skillMarket/classifySkill';

const handler = baseApi()
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

    const patch: Partial<ISkill> = { id: id as string };
    if (body.name !== undefined) patch.name = validateSkillName(body.name);
    if (body.description !== undefined) patch.description = validateSkillDescription(body.description);
    if (body.body !== undefined) patch.body = validateSkillBody(body.body);
    if (body.argumentHint !== undefined) patch.argumentHint = validateSkillArgumentHint(body.argumentHint);
    if (body.allowedTools !== undefined) patch.allowedTools = validateSkillAllowedTools(body.allowedTools);
    if (body.claudeCodeAllowedTools !== undefined) {
      patch.claudeCodeAllowedTools = validateSkillClaudeCodeAllowedTools(body.claudeCodeAllowedTools);
    }
    if (body.disableModelInvocation !== undefined) {
      patch.disableModelInvocation = Boolean(body.disableModelInvocation);
    }
    if (body.files !== undefined) patch.files = validateSkillFiles(body.files) ?? [];

    const scanMode = globalSkillScanFor(skill, patch, { id: req.user!.id, isAdmin: req.user!.isAdmin });
    if (scanMode !== 'none') {
      await scanGlobalSkillUpdate({ ...skill, ...patch }, scanMode, req, res, {
        getClassifier: () => getOperationsClassifierLlm(req.logger, req.user!.id),
        logger: req.logger,
        actorId: req.user!.id,
      });
    }

    // A global skill's write is conditioned on the version that was read (and scanned), so two
    // editors who each passed a scan on different fields can't combine into unscanned content: the
    // second write throws ConcurrencyConflictError (409). A non-global skill's write skipped the
    // scan, so it only lands while the skill is still non-global: a concurrent flip to global 409s.
    const isGlobal = Boolean(skill.isGlobalRead || skill.isGlobalWrite);
    // An undefined $set value is ignored by Mongoose; explicitly unset a cleared hint.
    const updateOptions: RepositoryUpdateOptions<ISkill> = {
      new: true,
      ...(body.argumentHint !== undefined && patch.argumentHint === undefined ? { unset: ['argumentHint'] } : {}),
    };

    try {
      const updated = isGlobal
        ? await skillRepository.updateGuarded(
            { __v: (skill as { __v?: number }).__v, ...patch } as Partial<ISkill>,
            updateOptions
          )
        : await skillRepository.updateIfNonGlobal(patch, updateOptions);
      res.json(updated ?? (await skillRepository.findById(id as string)));
    } catch (error) {
      // Rename-to-existing surfaces as a MongoDB duplicate-key error (code 11000)
      // because of the unique partial-filter index on (name, userId). Surface as
      // a friendly 400 instead of letting the 500 bubble through.
      if (isDuplicateKeyError(error) && patch.name !== undefined) {
        throw new BadRequestError(`A skill named "${patch.name}" already exists`);
      }
      throw error;
    }
  })
  .delete(async (req, res) => {
    const { id } = req.query;
    const skill = (await skillRepository.findById(id as string)) as ShareableSkill | null;
    if (!skill) throw new NotFoundError('Skill not found');

    if (!(await canDeleteSkill(skill, { id: req.user!.id, isAdmin: req.user!.isAdmin }))) {
      throw new ForbiddenError("You don't have permission to delete this skill");
    }

    await skillRepository.delete(id as string);
    res.status(204).end();
  });

export default handler;
