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
  organizationId: 'org-a',
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

  it('turns API posting off when the model-config flow moves a channel to another workspace', async () => {
    await slackChannelConfigRepository.setApiPostingByChannelId('C1', update);

    await slackChannelConfigRepository.upsertByChannelId('C1', { slackTeamId: 'T-team-b', configuredBy: 'U2' });

    const stored = await slackChannelConfigRepository.findByChannelId('C1');
    expect(stored).toMatchObject({ slackTeamId: 'T-team-b', apiPostEnabled: false, apiPostAllowedKeyIds: [] });
  });

  it('keeps API posting when the model-config flow edits the channel within the same workspace', async () => {
    await slackChannelConfigRepository.setApiPostingByChannelId('C1', update);

    await slackChannelConfigRepository.upsertByChannelId('C1', {
      slackTeamId: 'T-team-a',
      configuredBy: 'U2',
      preferredModel: 'm',
    });

    const stored = await slackChannelConfigRepository.findByChannelId('C1');
    expect(stored).toMatchObject({ apiPostEnabled: true, apiPostAllowedKeyIds: ['key-1'], preferredModel: 'm' });
  });

  it('never lets the model-config flow set the API-posting fields', async () => {
    await slackChannelConfigRepository.upsertByChannelId('C1', {
      slackTeamId: 'T-team-a',
      configuredBy: 'U1',
      apiPostEnabled: true,
      apiPostAllowedKeyIds: ['k'],
    });

    expect(await slackChannelConfigRepository.findByChannelId('C1')).toMatchObject({ apiPostEnabled: false });
  });

  it('records the granting organization on enable', async () => {
    const saved = await slackChannelConfigRepository.setApiPostingByChannelId('C1', update);
    expect(saved?.apiPostOrganizationId).toBe('org-a');
  });

  it("clears a workspace's opt-ins on disconnect, or only other organizations' on reconnect", async () => {
    await slackChannelConfigRepository.setApiPostingByChannelId('C1', update);
    await slackChannelConfigRepository.setApiPostingByChannelId('C2', { ...update, organizationId: 'org-old' });
    await slackChannelConfigRepository.setApiPostingByChannelId('C3', { ...update, slackTeamId: 'T-team-b' });

    expect(await slackChannelConfigRepository.clearApiPostingBySlackTeamId('T-team-a', 'org-a')).toEqual(['C2']);
    expect((await slackChannelConfigRepository.findByChannelId('C1'))?.apiPostEnabled).toBe(true);

    expect(await slackChannelConfigRepository.clearApiPostingBySlackTeamId('T-team-a')).toEqual(['C1']);
    expect(await slackChannelConfigRepository.findByChannelId('C1')).toMatchObject({
      apiPostEnabled: false,
      apiPostAllowedKeyIds: [],
    });
    expect((await slackChannelConfigRepository.findByChannelId('C1'))?.apiPostOrganizationId).toBeUndefined();
    expect((await slackChannelConfigRepository.findByChannelId('C3'))?.apiPostEnabled).toBe(true);
  });

  it('disables only an enabled record of the same workspace, and never creates one', async () => {
    expect(await slackChannelConfigRepository.disableApiPostingByChannelId('C-none', 'T-team-a')).toBeNull();
    expect(await slackChannelConfigRepository.findByChannelId('C-none')).toBeFalsy();

    await slackChannelConfigRepository.setApiPostingByChannelId('C1', update);
    expect(await slackChannelConfigRepository.disableApiPostingByChannelId('C1', 'T-team-b')).toBeNull();
    expect((await slackChannelConfigRepository.findByChannelId('C1'))?.apiPostEnabled).toBe(true);

    const before = await slackChannelConfigRepository.disableApiPostingByChannelId('C1', 'T-team-a');
    expect(before?.apiPostEnabled).toBe(true);
    const after = await slackChannelConfigRepository.findByChannelId('C1');
    expect(after).toMatchObject({ apiPostEnabled: false, apiPostAllowedKeyIds: [] });
    expect(after?.apiPostOrganizationId).toBeUndefined();
  });

  it("removes model settings within one workspace and keeps a channel's API posting opt-in", async () => {
    await slackChannelConfigRepository.upsertByChannelId('C1', {
      slackTeamId: 'T-team-a',
      configuredBy: 'u',
      preferredModel: 'm',
    });
    expect(await slackChannelConfigRepository.removeModelConfigByChannelId('C1', 'T-team-b')).toBe(false);
    expect(await slackChannelConfigRepository.findByChannelId('C1')).toBeTruthy();
    expect(await slackChannelConfigRepository.removeModelConfigByChannelId('C1', 'T-team-a')).toBe(true);
    expect(await slackChannelConfigRepository.findByChannelId('C1')).toBeFalsy();

    await slackChannelConfigRepository.setApiPostingByChannelId('C2', update);
    await slackChannelConfigRepository.upsertByChannelId('C2', { slackTeamId: 'T-team-a', preferredModel: 'm' });
    expect(await slackChannelConfigRepository.removeModelConfigByChannelId('C2', 'T-team-a')).toBe(true);
    const kept = await slackChannelConfigRepository.findByChannelId('C2');
    expect(kept).toMatchObject({ apiPostEnabled: true, apiPostOrganizationId: 'org-a' });
    expect(kept?.preferredModel).toBeUndefined();
  });
});
