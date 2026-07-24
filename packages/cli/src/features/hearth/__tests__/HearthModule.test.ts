import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HearthModule } from '../HearthModule.js';
import { createHearthTools } from '../hearthTools.js';
import type { ApiClient } from '../../../auth/ApiClient.js';
import type { IHearthService } from '../IHearthService.js';

function createMockApiClient(): ApiClient {
  return {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  } as unknown as ApiClient;
}

function createMockService(): IHearthService {
  return {
    listChannels: vi.fn().mockResolvedValue({ channels: [] }),
    postEvent: vi.fn().mockResolvedValue({ event: {} }),
    catchup: vi.fn().mockResolvedValue({ events: [], cursor: 0 }),
  };
}

describe('HearthModule', () => {
  let module: HearthModule;

  beforeEach(() => {
    module = new HearthModule(createMockApiClient());
  });

  it('exposes the expected tool set', () => {
    const names = module.getTools().map(t => t.toolSchema.name);
    expect(names).toEqual(['hearth_channels', 'hearth_post', 'hearth_catchup', 'hearth_watch', 'hearth_delegate']);
  });

  it('system prompt section documents every tool', () => {
    const prompt = module.getSystemPromptSection();
    for (const name of ['hearth_channels', 'hearth_post', 'hearth_catchup', 'hearth_watch', 'hearth_delegate']) {
      expect(prompt).toContain(name);
    }
  });

  it('registers a /hearth command that handles the empty state', () => {
    const commands = module.getCommands();
    const hearthCommand = commands.find(c => c.name === 'hearth');
    expect(hearthCommand).toBeDefined();

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    hearthCommand!.execute([]);
    const output = logSpy.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('No live events');
    logSpy.mockRestore();
  });
});

describe('hearthTools', () => {
  let service: IHearthService;

  beforeEach(() => {
    service = createMockService();
  });

  function getTool(name: string) {
    const tool = createHearthTools(service).find(t => t.toolSchema.name === name);
    expect(tool).toBeDefined();
    return tool!;
  }

  it('hearth_post maps snake_case params to a PostEventRequest', async () => {
    await getTool('hearth_post').toolFn({
      channel_id: 'ch-1',
      text: 'hello',
      reply_to_id: 'ev-9',
    });

    expect(service.postEvent).toHaveBeenCalledWith({
      channelId: 'ch-1',
      kind: 'message',
      human: { text: 'hello', format: 'md' },
      machine: undefined,
      refs: { threadRootId: undefined, replyToId: 'ev-9', questId: undefined },
    });
  });

  it('hearth_post attaches a machine payload when machine_schema is set', async () => {
    await getTool('hearth_post').toolFn({
      channel_id: 'ch-1',
      text: 'build done',
      kind: 'artifact',
      machine_schema: 'myapp.build.result@1',
      machine_payload: { ok: true },
    });

    expect(service.postEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'artifact',
        machine: { schema: 'myapp.build.result@1', payload: { ok: true } },
      })
    );
  });

  it('hearth_catchup advances the cursor; hearth_watch does not', async () => {
    await getTool('hearth_catchup').toolFn({ channel_id: 'ch-1', limit: 10 });
    expect(service.catchup).toHaveBeenCalledWith('ch-1', { advance: true, limit: 10 });

    await getTool('hearth_watch').toolFn({ channel_id: 'ch-1' });
    expect(service.catchup).toHaveBeenCalledWith('ch-1', { advance: false, limit: undefined });
  });

  it('hearth_delegate posts a delegation event with a typed payload', async () => {
    await getTool('hearth_delegate').toolFn({
      channel_id: 'ch-1',
      target_actor_id: 'actor-42',
      task: 'run the tests',
      payload: { cwd: '/repo' },
    });

    expect(service.postEvent).toHaveBeenCalledWith({
      channelId: 'ch-1',
      kind: 'delegation',
      human: { text: 'Delegation to actor-42: run the tests', format: 'text' },
      machine: {
        schema: 'hearth.delegation@1',
        payload: { targetActorId: 'actor-42', task: 'run the tests', cwd: '/repo' },
      },
      refs: {},
    });
  });

  it('hearth_delegate payload keys cannot clobber the canonical fields', async () => {
    await getTool('hearth_delegate').toolFn({
      channel_id: 'ch-1',
      target_actor_id: 'actor-42',
      task: 'run the tests',
      payload: { task: 'rm -rf /', targetActorId: 'attacker' },
    });

    expect(service.postEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        machine: expect.objectContaining({
          payload: { targetActorId: 'actor-42', task: 'run the tests' },
        }),
      })
    );
  });

  it('rejects malformed params', async () => {
    await expect(getTool('hearth_post').toolFn({ text: 'no channel' })).rejects.toThrow();
    await expect(getTool('hearth_delegate').toolFn({ channel_id: 'ch-1' })).rejects.toThrow();
  });

  it('rejects machine_payload without machine_schema instead of silently dropping it', async () => {
    await expect(
      getTool('hearth_post').toolFn({ channel_id: 'ch-1', text: 'hi', machine_payload: { ok: true } })
    ).rejects.toThrow(/machine_schema/);
    expect(service.postEvent).not.toHaveBeenCalled();
  });
});
