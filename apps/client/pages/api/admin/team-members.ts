import { internalTeamMemberRepository } from '@bike4mind/database';
import { adminApi } from '@server/middlewares/adminApi';
import { definedKeys, recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import {
  ApiKeyScope,
  InternalTeamMemberSchema,
  internalTeamMemberListResponseSchema,
  internalTeamMemberResponseSchema,
} from '@bike4mind/common';
import { respond } from '@server/utils/respond';
import { z } from 'zod';

const TeamMemberCreateSchema = InternalTeamMemberSchema.omit({ isActive: true }).extend({
  isActive: z.boolean().optional(),
});

const TeamMemberUpdateSchema = TeamMemberCreateSchema.partial().extend({
  id: z.string().min(1, 'Team member id is required'),
});

const handler = adminApi({
  requiredScopes: [ApiKeyScope.ADMIN],
  adminPermissions: {
    GET: 'settings:manage',
    POST: 'settings:manage',
    PUT: 'settings:manage',
    DELETE: 'settings:manage',
  },
})
  .get(async (req, res) => {
    const includeInactive = req.query.includeInactive === 'true';

    const members = includeInactive
      ? await internalTeamMemberRepository.find({}, { sort: { name: 1 } })
      : await internalTeamMemberRepository.findAllActive();

    return respond(res, internalTeamMemberListResponseSchema, members);
  })
  .post(async (req, res) => {
    const parsed = TeamMemberCreateSchema.safeParse(req.body);

    if (!parsed.success) {
      throw new BadRequestError(parsed.error.issues.map(err => err.message).join(', '));
    }

    const payload = parsed.data;

    // Check for existing member
    const existing = await internalTeamMemberRepository.findByPhone(payload.phone);

    if (existing) {
      throw new BadRequestError('A team member with this phone number already exists.');
    }

    const created = await internalTeamMemberRepository.create({
      ...payload,
      isActive: payload.isActive ?? true,
    });

    await recordAdminActionFromRequest(req, {
      action: 'settings.team_member.created',
      target: { kind: 'settings', id: created.id, displayName: created.name },
      summary: `created team member ${created.name}`,
      details: { role: created.role, department: created.department, isActive: created.isActive },
    });

    return respond(res, internalTeamMemberResponseSchema, created, 201);
  })
  .put(async (req, res) => {
    const parsed = TeamMemberUpdateSchema.safeParse(req.body);

    if (!parsed.success) {
      throw new BadRequestError(parsed.error.issues.map(err => err.message).join(', '));
    }

    const payload = parsed.data;

    const updated = await internalTeamMemberRepository.update(payload);

    if (!updated) {
      throw new BadRequestError('Team member not found.');
    }

    // Field names only: the phone number and email are personal data.
    const { id: updatedId, ...updatedFields } = payload;
    await recordAdminActionFromRequest(req, {
      action: 'settings.team_member.updated',
      target: { kind: 'settings', id: updatedId, displayName: updated.name },
      summary: `updated team member ${updated.name}`,
      details: { fields: definedKeys(updatedFields) },
    });

    return respond(res, internalTeamMemberResponseSchema, updated);
  })
  .delete(async (req, res) => {
    const id = req.query.id;

    if (!id || typeof id !== 'string') {
      throw new BadRequestError('Team member id is required.');
    }

    const existing = await internalTeamMemberRepository.findById(id);
    await internalTeamMemberRepository.delete(id);

    if (existing) {
      await recordAdminActionFromRequest(req, {
        action: 'settings.team_member.deleted',
        target: { kind: 'settings', id, displayName: existing.name },
        summary: `deleted team member ${existing.name}`,
        details: { role: existing.role, department: existing.department },
      });
    }

    return res.json({ success: true });
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
