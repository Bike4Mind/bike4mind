import { beforeEach, describe, expect, it, vi } from 'vitest';

const viewsOpen = vi.fn();
const viewsUpdate = vi.fn();
const buildSlackModelOptionsFromDashboard = vi.fn();
const orgFindById = vi.fn();
const findByChannelId = vi.fn();
const removeModelConfigByChannelId = vi.fn();
const upsertByChannelId = vi.fn();

vi.mock('@slack/web-api', () => ({
  WebClient: class {
    views = { open: viewsOpen, update: viewsUpdate };
  },
}));
vi.mock('@bike4mind/observability', () => ({
  Logger: Object.assign(
    class {
      info = vi.fn();
      warn = vi.fn();
      error = vi.fn();
    },
    { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  ),
}));
vi.mock('../SlackClient', () => ({
  SlackClient: class {
    getUserInfo = vi.fn(async () => ({ is_admin: true }));
  },
}));
vi.mock('./user-lookup', () => ({ findUserBySlackId: vi.fn(async () => ({ organizationId: 'org-1' })) }));
vi.mock('../views/AppHomeBuilder', () => ({ AppHomeBuilder: class {} }));
vi.mock('../services/AppHomeDataService', () => ({ AppHomeDataService: class {} }));
vi.mock('../constants/slack-model-options', () => ({
  buildSlackModelOptionsFromDashboard: () => buildSlackModelOptionsFromDashboard(),
}));
vi.mock('../di/registry', () => ({
  getSlackDb: () => ({
    Organization: { findById: orgFindById },
    slackChannelConfigRepository: { findByChannelId, removeModelConfigByChannelId, upsertByChannelId },
  }),
}));

import {
  handleChannelConfigAdd,
  handleChannelConfigEdit,
  handleChannelConfigRemove,
  handleChannelModelConfigSubmission,
  handleOrgDefaultsEdit,
} from './modelConfigHandlers';

const OPTIONS = {
  option_groups: [
    {
      label: { type: 'plain_text', text: 'OpenAI' },
      options: [{ text: { type: 'plain_text', text: 'GPT' }, value: 'gpt' }],
    },
  ],
  flat: [{ text: { type: 'plain_text', text: 'GPT' }, value: 'gpt' }],
};

/** A listing that stays pending until the test releases it, like a stalled catalog read. */
function stallListing() {
  let release!: () => void;
  buildSlackModelOptionsFromDashboard.mockReturnValue(
    new Promise(resolve => {
      release = () => resolve(OPTIONS);
    })
  );
  return () => release();
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

const cases = [
  // The edit handlers pre-select the saved model; a new channel config has none.
  { name: 'handleOrgDefaultsEdit', open: () => handleOrgDefaultsEdit('U1', 'trigger-1', 'xoxb'), preselects: true },
  {
    name: 'handleChannelConfigAdd',
    open: () => handleChannelConfigAdd('U1', 'T1', 'trigger-1', 'xoxb'),
    preselects: false,
  },
  {
    name: 'handleChannelConfigEdit',
    open: () => handleChannelConfigEdit('U1', 'C1', 'T1', 'trigger-1', 'xoxb'),
    preselects: true,
  },
];

describe('model config modal handlers', () => {
  beforeEach(() => {
    viewsOpen.mockReset().mockResolvedValue({ view: { id: 'V1', hash: 'h1' } });
    viewsUpdate.mockReset().mockResolvedValue({});
    buildSlackModelOptionsFromDashboard.mockReset();
    orgFindById.mockReset().mockReturnValue({ select: () => ({ lean: async () => ({ preferredModel: 'gpt' }) }) });
    findByChannelId.mockReset().mockResolvedValue({ preferredModel: 'gpt' });
  });

  it.each(cases)('$name opens the modal before a stalled model listing resolves', async ({ open, preselects }) => {
    const release = stallListing();

    const pending = open();
    await flush();

    // The trigger_id is spent while the listing is still pending.
    expect(viewsOpen).toHaveBeenCalledTimes(1);
    expect(viewsOpen.mock.calls[0][0].trigger_id).toBe('trigger-1');
    expect(JSON.stringify(viewsOpen.mock.calls[0][0].view)).toContain('Loading');
    expect(viewsUpdate).not.toHaveBeenCalled();

    release();
    await expect(pending).resolves.toEqual({});

    expect(viewsUpdate).toHaveBeenCalledTimes(1);
    const update = viewsUpdate.mock.calls[0][0];
    expect(update).toMatchObject({ view_id: 'V1', hash: 'h1' });
    const select = update.view.blocks.find((b: { block_id?: string }) => b.block_id === 'model_block').element;
    expect(select.option_groups).toEqual(OPTIONS.option_groups);
    expect(select.initial_option).toEqual(preselects ? OPTIONS.flat[0] : undefined);
  });

  it('replaces the loading view with an error when building the modal fails', async () => {
    buildSlackModelOptionsFromDashboard.mockResolvedValue(OPTIONS);
    orgFindById.mockReturnValue({
      select: () => ({
        lean: async () => {
          throw new Error('db down');
        },
      }),
    });

    await expect(handleOrgDefaultsEdit('U1', 'trigger-1', 'xoxb')).resolves.toEqual({
      text: 'Failed to open configuration dialog.',
    });
    expect(viewsOpen).toHaveBeenCalledTimes(1);
    expect(viewsUpdate).toHaveBeenCalledTimes(1);
    expect(viewsUpdate.mock.calls[0][0].view_id).toBe('V1');
    expect(JSON.stringify(viewsUpdate.mock.calls[0][0].view)).toContain('Failed to load');
  });
});

describe('handleChannelConfigRemove', () => {
  it("removes the channel's settings within the clicking workspace only", async () => {
    removeModelConfigByChannelId.mockReset().mockResolvedValue(true);

    await expect(handleChannelConfigRemove('U-admin', 'C1', 'T1', 'xoxb-test')).resolves.toEqual({});

    expect(removeModelConfigByChannelId).toHaveBeenCalledWith('C1', 'T1');
  });
});

describe('handleChannelModelConfigSubmission', () => {
  const submit = () =>
    handleChannelModelConfigSubmission({
      user: { id: 'U-admin' },
      view: {
        private_metadata: JSON.stringify({ slackTeamId: 'T2', channelId: 'C1' }),
        state: { values: { model_block: { model_select: { selected_option: { value: 'gpt' } } } } },
      },
    } as unknown as Parameters<typeof handleChannelModelConfigSubmission>[0]);

  it('saves the settings', async () => {
    upsertByChannelId.mockReset().mockResolvedValue({ channelId: 'C1', slackTeamId: 'T2' });

    await expect(submit()).resolves.toEqual({});
    expect(upsertByChannelId).toHaveBeenCalledWith('C1', expect.objectContaining({ slackTeamId: 'T2' }));
  });

  it("explains the refusal when the channel is API-posting enabled by the other workspace's organization", async () => {
    upsertByChannelId.mockReset().mockResolvedValue(null);

    const response = await submit();

    expect(response).toMatchObject({ response_action: 'errors' });
    expect((response as { errors: Record<string, string> }).errors.model_block).toMatch(/enabled for API posting/);
  });
});
