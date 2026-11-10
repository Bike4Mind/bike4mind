/**
 * Create and update paths shared by the SPA skill routes (pages/api/skills) and the public
 * /api/v1/skills routes, so both validate and write identically.
 */
import type { RequestHandler } from 'express';
import { skillRepository } from '@bike4mind/database';
import type { RepositoryUpdateOptions } from '@bike4mind/common';
import type { ISkill, ISkillDocument } from '@bike4mind/common';
import { BadRequestError } from '@bike4mind/utils';
import { isDuplicateKeyError } from '@bike4mind/server-utils/utils/isDuplicateKeyError';
import { ensureAdmin } from '@bike4mind/server-utils/utils/errors';
import { verifyOrgAccess } from '@bike4mind/server-utils/utils/orgAccess';
import {
  validateSkillName,
  validateSkillDescription,
  validateSkillBody,
  validateSkillArgumentHint,
  validateSkillAllowedTools,
  validateSkillFiles,
  validateSkillClaudeCodeAllowedTools,
} from '@server/utils/skillValidation';
import { ShareableSkill, globalSkillScanFor } from '@server/utils/skillAccess';
import { scanGlobalSkillUpdate } from '@server/skillMarket/globalSkillUpdate';
import { getOperationsClassifierLlm } from '@server/skillMarket/classifySkill';

/** Scope fields written to the new skill - exactly one is set (model invariant). */
export type SkillScope = { userId: string } | { organizationId: string } | { isSystem: true };

export type SkillCreateBody = Partial<ISkill> & { scope?: { organizationId?: string; isSystem?: boolean } };

/**
 * Resolve and authorize the scope for a new skill from the optional
 * `scope` payload. Defaults to user-scoped (backward compatible). Org-scoped
 * creation requires the caller to be an admin/owner/manager of that org;
 * system-scoped creation requires a super-admin.
 */
export async function resolveCreateScope(
  body: Pick<SkillCreateBody, 'scope'>,
  user: { id: string; isAdmin: boolean }
): Promise<SkillScope> {
  const scope = body.scope;
  if (!scope || (!scope.organizationId && !scope.isSystem)) {
    return { userId: user.id };
  }
  if (scope.organizationId && scope.isSystem) {
    throw new BadRequestError('A skill cannot be both organization-scoped and system-scoped');
  }

  if (scope.isSystem) {
    // System skills are global built-ins - super-admin only.
    ensureAdmin(user.isAdmin);
    return { isSystem: true };
  }

  // verifyOrgAccess admits the same set that can later manage the skill (skillAccess.isOrgAdminFor).
  await verifyOrgAccess(user, scope.organizationId as string);
  return { organizationId: scope.organizationId as string };
}

/** Bounds-checks the content fields of a new skill. Throws BadRequestError with a plain-language fix. */
export function validateNewSkill(body: Partial<ISkill>) {
  return {
    name: validateSkillName(body.name),
    description: validateSkillDescription(body.description),
    body: validateSkillBody(body.body),
    argumentHint: validateSkillArgumentHint(body.argumentHint),
    allowedTools: validateSkillAllowedTools(body.allowedTools),
    files: validateSkillFiles(body.files),
    claudeCodeAllowedTools: validateSkillClaudeCodeAllowedTools(body.claudeCodeAllowedTools),
    disableModelInvocation: Boolean(body.disableModelInvocation),
  };
}

/**
 * Inserts a validated skill. Uniqueness is enforced by a partial unique index on (name, userId)
 * where deletedAt: null - catching the duplicate-key error here keeps the create path atomic AND
 * still yields a friendly error (`onDuplicateName` picks its status).
 */
export async function insertSkill(
  fields: ReturnType<typeof validateNewSkill>,
  scope: SkillScope,
  onDuplicateName: (name: string) => Error = name => new BadRequestError(`A skill named "${name}" already exists`)
): Promise<ISkillDocument> {
  const { argumentHint, allowedTools, files, claudeCodeAllowedTools, ...rest } = fields;
  try {
    return await skillRepository.create({
      ...rest,
      ...(argumentHint !== undefined && { argumentHint }),
      ...(allowedTools !== undefined && { allowedTools }),
      ...(files?.length ? { files } : {}),
      ...(claudeCodeAllowedTools?.length && { claudeCodeAllowedTools }),
      ...scope,
      isGlobalRead: false,
      isGlobalWrite: false,
      users: [],
      groups: [],
    } as Omit<ISkillDocument, 'id' | 'createdAt' | 'updatedAt'>);
  } catch (error) {
    if (isDuplicateKeyError(error)) throw onDuplicateName(fields.name);
    throw error;
  }
}

/**
 * Validates `body` as a partial update of `skill` and writes it, running the global-skill content
 * scan when the skill is shared with everyone. The caller has already checked edit access.
 */
export async function applySkillUpdate(
  skill: ShareableSkill,
  body: Partial<Omit<ISkill, 'argumentHint'>> & { argumentHint?: string | null },
  req: Parameters<RequestHandler>[0],
  res: Parameters<RequestHandler>[1],
  onDuplicateName: (name: string) => Error = name => new BadRequestError(`A skill named "${name}" already exists`)
): Promise<ISkillDocument | null> {
  const actor = { id: req.user!.id, isAdmin: req.user!.isAdmin };
  const patch: Partial<ISkill> = { id: skill.id };
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

  const scanMode = globalSkillScanFor(skill, patch, actor);
  if (scanMode !== 'none') {
    await scanGlobalSkillUpdate({ ...skill, ...patch }, scanMode, req, res, {
      getClassifier: () => getOperationsClassifierLlm(req.logger, actor.id),
      logger: req.logger,
      actorId: actor.id,
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
    return updated ?? (await skillRepository.findById(skill.id));
  } catch (error) {
    // Rename-to-existing surfaces as a MongoDB duplicate-key error (code 11000)
    // because of the unique partial-filter index on (name, userId).
    if (isDuplicateKeyError(error) && patch.name !== undefined) throw onDuplicateName(patch.name);
    throw error;
  }
}
