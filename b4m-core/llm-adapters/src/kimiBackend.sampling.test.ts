import { ChatModels, type IMessage } from '@bike4mind/common';
import { describe, expect, it, vi } from 'vitest';
import { KimiBackend } from './kimiBackend';

/**
 * The request body Moonshot actually receives. Every current Kimi pins the
 * sampling group, and a non-1 temperature is answered with
 * "400 invalid temperature: only 1 is allowed for this model" - so no caller
 * option may reach the wire on those ids, including ids that only the model
 * catalog knows about.
 */

function captureRequest() {
  const backend = new KimiBackend('test-key');
  const create = vi.fn().mockResolvedValue({
    choices: [{ index: 0, message: { content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  });
  // The client is private; swapping it keeps this a unit test, not a live call.
  (backend as unknown as { _api: unknown })._api = { chat: { completions: { create } } };
  return { backend, create };
}

async function sentParams(model: string): Promise<Record<string, unknown>> {
  const { backend, create } = captureRequest();
  const messages = [{ role: 'user', content: 'hi' } as IMessage];
  await backend.complete(
    model,
    messages,
    { stream: false, temperature: 0.9, topP: 0.5, presencePenalty: 0.2, frequencyPenalty: 0.3 },
    async () => {}
  );
  expect(create).toHaveBeenCalled();
  return create.mock.calls[0][0] as Record<string, unknown>;
}

const SAMPLING_KEYS = ['temperature', 'top_p', 'presence_penalty', 'frequency_penalty'];

describe('KimiBackend sampling params on the wire', () => {
  it.each([ChatModels.KIMI_K3, 'kimi-k3.1-pro-highspeed'])('sends no sampling params for %s', async model => {
    const params = await sentParams(model);
    for (const key of SAMPLING_KEYS) expect(params).not.toHaveProperty(key);
  });

  it('keeps the caller sampling params on the moonshot-v1 family', async () => {
    const params = await sentParams('moonshot-v1-8k');
    expect(params).toMatchObject({ temperature: 0.9, top_p: 0.5, presence_penalty: 0.2, frequency_penalty: 0.3 });
  });
});
