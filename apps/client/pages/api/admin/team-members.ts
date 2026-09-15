import { internalTeamMemberRepository } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, ForbiddenError } from '@server/utils/errors';
import { InternalTeamMemberSchema } from '@bike4mind/common';
import { z } from 'zod';

const TeamMemberCreateSchema = InternalTeamMemberSchema.omit({ isActive: true }).extend({
  isActive: z.boolean().optional(),
});

const TeamMemberUpdateSchema = TeamMemberCreateSchema.partial().extend({
  id: z.string().min(1, 'Team member id is required'),
});

const ensureAdmin = (isAdmin?: boolean | null) => {
  if (!isAdmin) {
    throw new ForbiddenError('Unauthorized. Admin access required.');
  }
};

const handler = baseApi()
  .get(async (req, res) => {
    ensureAdmin(req.user?.isAdmin);

    const includeInactive = req.query.includeInactive === 'true';

    const members = includeInactive
      ? await internalTeamMemberRepository.find({}, { sort: { name: 1 } })
      : await internalTeamMemberRepository.findAllActive();

    return res.json(members);
  })
  .post(async (req, res) => {
    ensureAdmin(req.user?.isAdmin);

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

    return res.status(201).json(created);
  })
  .put(async (req, res) => {
    ensureAdmin(req.user?.isAdmin);

    const parsed = TeamMemberUpdateSchema.safeParse(req.body);

    if (!parsed.success) {
      throw new BadRequestError(parsed.error.issues.map(err => err.message).join(', '));
    }

    const payload = parsed.data;

    const updated = await internalTeamMemberRepository.update(payload);

    if (!updated) {
      throw new BadRequestError('Team member not found.');
    }

    return res.json(updated);
  })
  .delete(async (req, res) => {
    ensureAdmin(req.user?.isAdmin);

    const id = req.query.id;

    if (!id || typeof id !== 'string') {
      throw new BadRequestError('Team member id is required.');
    }

    await internalTeamMemberRepository.delete(id);

    return res.json({ success: true });
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
