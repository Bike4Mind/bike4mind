import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { Organization, User } from '@bike4mind/database';
import { resolveFeedbackOrganization } from './feedbackOrganization';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

/**
 * `organizationId` is an authorization key - it decides which org-scoped readers can see a report -
 * so the unresolvable cases are the ones worth pinning. Run against a real mongod because the
 * `{ email: undefined }` trap below is a BSON serialization behavior that no mock reproduces.
 */
let mongoServer: MongoMemoryServer | undefined;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

afterEach(async () => {
  await mongoose.connection.dropDatabase();
});

describe('resolveFeedbackOrganization', () => {
  it('resolves both fields from the submitter org', async () => {
    const org = await Organization.create({ name: 'Acme Health', userId: 'owner-1' });
    const user = await User.create({
      username: 'member',
      name: 'Member',
      email: 'member@example.com',
      organizationId: org._id,
    });

    expect(await resolveFeedbackOrganization({ userId: user.id })).toEqual({
      organization: 'Acme Health',
      organizationId: org.id,
    });
  });

  /**
   * The asymmetry is deliberate: the label falls back so the admin list renders something, the id
   * falls back to null so an unresolvable report is invisible to every org-scoped reader rather
   * than visible to an arbitrary one.
   */
  it('falls back to the neutral label and a null id when the user has no org', async () => {
    const user = await User.create({ username: 'solo', name: 'Solo', email: 'solo@example.com' });

    expect(await resolveFeedbackOrganization({ userId: user.id })).toEqual({
      organization: 'Unknown',
      organizationId: null,
    });
  });

  /**
   * The guard that earns its keep: Mongoose serializes `{ email: undefined }` as BSON null, so the
   * query would match an arbitrary account that happens to carry no email - and hand back ITS org
   * as the authorization key. An absent email has to resolve to nothing instead.
   */
  it('returns the neutral fallback for an absent email instead of an arbitrary account', async () => {
    const org = await Organization.create({ name: 'Acme Health', userId: 'owner-1' });
    // An email-less account carrying an org - exactly what `{ email: null }` would match.
    await User.create({ username: 'emailless', name: 'No Email', organizationId: org._id });

    const lookup = { email: undefined } as unknown as Parameters<typeof resolveFeedbackOrganization>[0];
    expect(await resolveFeedbackOrganization(lookup)).toEqual({
      organization: 'Unknown',
      organizationId: null,
    });
    expect(await resolveFeedbackOrganization({ email: '' })).toEqual({
      organization: 'Unknown',
      organizationId: null,
    });
  });

  it('resolves the anonymous branch by email', async () => {
    const org = await Organization.create({ name: 'Acme Health', userId: 'owner-1' });
    await User.create({
      username: 'member',
      name: 'Member',
      email: 'member@example.com',
      organizationId: org._id,
    });

    expect(await resolveFeedbackOrganization({ email: 'member@example.com' })).toEqual({
      organization: 'Acme Health',
      organizationId: org.id,
    });
  });
});
