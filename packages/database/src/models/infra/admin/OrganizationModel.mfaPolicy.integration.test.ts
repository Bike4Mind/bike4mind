import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { Permission } from '@bike4mind/common';
import { createMongoServer } from '../../../__test__/createMongoServer';
import { Organization, organizationRepository } from './OrganizationModel';

let server: Awaited<ReturnType<typeof createMongoServer>>;
beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri(), { autoIndex: false });
});
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});

describe('organization login MFA policy persistence', () => {
  it('persists the policy and matches expired policies only in actual member teams', async () => {
    const now = new Date('2030-01-10T00:00:00Z');
    const team = await Organization.create({
      name: 'Team',
      userId: 'owner',
      personal: false,
      users: [
        { userId: 'member', permissions: [Permission.read] },
        { userId: 'pending', permissions: [] },
      ],
      mfaPolicy: { required: true, graceEndsAt: now },
    });
    const personal = await Organization.create({
      name: 'Personal',
      userId: 'member',
      personal: true,
      mfaPolicy: { required: true, graceEndsAt: now },
    });
    const match = async (userId: string, date = now) =>
      Organization.exists({
        _id: { $in: await organizationRepository.findMembershipOrgIds(userId) },
        personal: false,
        'mfaPolicy.required': true,
        'mfaPolicy.graceEndsAt': { $ne: null, $lte: date },
      });

    expect((await Organization.findById(team.id).lean())?.mfaPolicy).toEqual({ required: true, graceEndsAt: now });
    expect(await match('member')).toBeTruthy();
    expect(await match('owner')).toBeTruthy();
    expect(await match('pending')).toBeNull();
    expect(await match('outsider')).toBeNull();
    expect(await match('member', new Date(now.getTime() - 1))).toBeNull();
    await Organization.findByIdAndUpdate(team.id, { $set: { 'mfaPolicy.required': false } });
    expect(await match('member')).toBeNull();
    await Organization.findByIdAndUpdate(team.id, {
      $set: { 'mfaPolicy.required': true, 'mfaPolicy.graceEndsAt': null },
    });
    expect(await match('member')).toBeNull();
    await Organization.findByIdAndUpdate(team.id, { $set: { 'mfaPolicy.graceEndsAt': now } });
    await Organization.deleteOne({ _id: team._id });
    expect(await match('member')).toBeNull();
    expect(await Organization.findById(personal.id)).toBeTruthy();
  });
});
