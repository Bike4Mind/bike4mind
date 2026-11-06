// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { adminAuditLogRepository, AdminGateReservationModel } from '@bike4mind/database';
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../packages/database/src/__test__/createMongoServer';

const POLICY = { enabled: true, creditThreshold: 1000, bulkUserThreshold: 25, expiryHours: 24 };
vi.mock('@server/admin/approvals/service', () => ({ getApprovalPolicy: async () => POLICY }));

import { creditGrantNeedsApproval, reserveWithinWindow } from './gate';

const ADMIN = 'a'.repeat(24);
const DAY_MS = 24 * 60 * 60 * 1000;
let server: MongoMemoryServer;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
}, MONGO_TEST_TIMEOUT_MS);

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});

afterEach(async () => {
  await mongoose.connection.dropDatabase();
});

describe('approval threshold window under concurrent requests', () => {
  it('lets at most one of two simultaneous grants run when only their sum is over the threshold', async () => {
    for (let round = 0; round < 10; round++) {
      const gates = await Promise.all([creditGrantNeedsApproval(600, ADMIN), creditGrantNeedsApproval(600, ADMIN)]);
      const ran = gates.filter(gate => gate.policy === null);
      expect(ran.length).toBeLessThanOrEqual(1);
      for (const gate of ran) if (!gate.policy) await gate.release();
      expect(await AdminGateReservationModel.countDocuments()).toBe(0);
    }
  });

  it('keeps the credits of many simultaneous grants that run within the threshold', async () => {
    const gates = await Promise.all(Array.from({ length: 8 }, () => creditGrantNeedsApproval(300, ADMIN)));
    const ran = gates.filter(gate => gate.policy === null);
    expect(ran.length * 300).toBeLessThanOrEqual(POLICY.creditThreshold);
    expect(await AdminGateReservationModel.countDocuments()).toBe(ran.length);
  });

  it('holds a running grant against the next one until it is released', async () => {
    const first = await creditGrantNeedsApproval(600, ADMIN);
    expect(first.policy).toBeNull();
    expect(await creditGrantNeedsApproval(600, ADMIN)).toEqual({ policy: POLICY });
    if (!first.policy) await first.release();
    const second = await creditGrantNeedsApproval(600, ADMIN);
    expect(second.policy).toBeNull();
    expect(await creditGrantNeedsApproval(600, 'b'.repeat(24))).toMatchObject({ policy: null });
  });

  it('applies the same reservation to the bulk user count', async () => {
    const recorded = () =>
      adminAuditLogRepository.countActions(ADMIN, ['user.bulk.suspended'], new Date(Date.now() - DAY_MS));
    for (let round = 0; round < 10; round++) {
      const releases = await Promise.all([
        reserveWithinWindow(ADMIN, 'users', 15, 25, DAY_MS, recorded),
        reserveWithinWindow(ADMIN, 'users', 15, 25, DAY_MS, recorded),
      ]);
      const ran = releases.filter(release => release !== null);
      expect(ran.length).toBeLessThanOrEqual(1);
      await Promise.all(ran.map(release => release()));
    }
  });
});
