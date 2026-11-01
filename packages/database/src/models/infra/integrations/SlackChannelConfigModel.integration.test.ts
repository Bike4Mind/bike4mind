import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer } from '../../../__test__/createMongoServer';
import { SlackChannelConfig, slackChannelConfigRepository } from './SlackChannelConfigModel';

/**
 * The API-posting opt-in (`POST /api/v1/slack/messages`): set only by an org owner, never moving a
 * channel's config to another workspace, and leaving the channel's model settings untouched.
 */

let server: Awaited<ReturnType<typeof createMongoServer>>;

const update = {
  slackTeamId: 'T-team-a',
  apiPostEnabled: true,
  apiPostAllowedKeyIds: ['key-1'],
  configuredBy: 'owner-1',
};

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  await SlackChannelConfig.createIndexes();
}, 30000);

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
}, 30000);

afterEach(async () => {
  await SlackChannelConfig.deleteMany({});
});

describe('SlackChannelConfigModel - API posting opt-in', () => {
  it('defaults to off on a config created by the model-config flow', async () => {
    await slackChannelConfigRepository.upsertByChannelId('C1', { slackTeamId: 'T-team-a', configuredBy: 'U1' });
    const config = await slackChannelConfigRepository.findByChannelId('C1');
    expect(config?.apiPostEnabled).toBe(false);
  });

  it('creates the config when absent, with the owner as configuredBy', async () => {
    const saved = await slackChannelConfigRepository.setApiPostingByChannelId('C1', update);
    expect(saved).toMatchObject({
      channelId: 'C1',
      slackTeamId: 'T-team-a',
      apiPostEnabled: true,
      apiPostAllowedKeyIds: ['key-1'],
      configuredBy: 'owner-1',
    });
  });

  it('changes only the posting fields of an existing config', async () => {
    await slackChannelConfigRepository.upsertByChannelId('C1', {
      slackTeamId: 'T-team-a',
      configuredBy: 'U1',
      preferredModel: 'some-model',
    });

    const saved = await slackChannelConfigRepository.setApiPostingByChannelId('C1', update);

    expect(saved).toMatchObject({ preferredModel: 'some-model', configuredBy: 'U1', apiPostEnabled: true });
  });

  it('refuses to re-home a channel configured under another workspace', async () => {
    await slackChannelConfigRepository.upsertByChannelId('C1', { slackTeamId: 'T-team-b', configuredBy: 'U1' });

    const saved = await slackChannelConfigRepository.setApiPostingByChannelId('C1', update);

    expect(saved).toBeNull();
    const stored = await slackChannelConfigRepository.findByChannelId('C1');
    expect(stored).toMatchObject({ slackTeamId: 'T-team-b', apiPostEnabled: false });
  });

  it('lists only the enabled channels of one workspace', async () => {
    await slackChannelConfigRepository.setApiPostingByChannelId('C1', update);
    await slackChannelConfigRepository.setApiPostingByChannelId('C2', { ...update, apiPostEnabled: false });
    await slackChannelConfigRepository.setApiPostingByChannelId('C3', { ...update, slackTeamId: 'T-team-b' });

    const enabled = await slackChannelConfigRepository.findApiPostEnabledBySlackTeamId('T-team-a');
    expect(enabled.map(config => config.channelId)).toEqual(['C1']);
  });
});
