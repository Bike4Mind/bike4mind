import { afterAll, beforeAll, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer } from '../../../__test__/createMongoServer';
import { SlackFeedbackChannel, SlackFeedbackDelivery } from './SlackFeedbackModel';

let server: Awaited<ReturnType<typeof createMongoServer>>;
beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  await Promise.all([SlackFeedbackChannel.init(), SlackFeedbackDelivery.init()]);
});
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});
it('allows only one durable message claim and one claim per callback status under concurrency', async () => {
  const record = {
    _id: 'message1',
    organizationId: 'org1',
    workspaceId: 'ws1',
    slackTeamId: 'T1',
    channelId: 'C1',
    messageTs: '123.456',
    reactor: 'U1',
    destinationId: 'test',
    state: 'sent',
  };
  const claims = await Promise.allSettled(Array.from({ length: 10 }, () => SlackFeedbackDelivery.create(record)));
  expect(claims.filter(claim => claim.status === 'fulfilled')).toHaveLength(1);
  const statuses = await Promise.all(
    Array.from({ length: 10 }, () =>
      SlackFeedbackDelivery.updateOne(
        { _id: 'message1', state: 'sent', statuses: { $ne: 'filed' } },
        { $addToSet: { statuses: 'filed' } }
      )
    )
  );
  expect(statuses.reduce((sum, result) => sum + result.modifiedCount, 0)).toBe(1);
});
