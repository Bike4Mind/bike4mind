import { describe, it, expect } from 'vitest';
import { ChatModels, type IMessage } from '@bike4mind/common';
import { GeminiBackend } from './geminiBackend';
import { buildIdentityReminder } from './identityReminder';

const MODEL = ChatModels.GEMINI_2_5_FLASH_LITE;
const REMINDER = buildIdentityReminder(MODEL);

type CapturedRequest = { config?: { systemInstruction?: string } };

function backendWithCapture() {
  const backend = new GeminiBackend('test-key');
  const requests: CapturedRequest[] = [];
  const response = { candidates: [{ content: { parts: [{ text: 'ok' }] } }] };
  (backend as unknown as { _api: unknown })._api = {
    models: {
      generateContent: async (request: CapturedRequest) => {
        requests.push(request);
        return response;
      },
    },
  };
  return { backend, requests };
}

async function run(messages: IMessage[], options: Record<string, unknown> = {}) {
  const { backend, requests } = backendWithCapture();
  await backend.complete(MODEL, messages, { stream: false, ...options }, async () => {});
  return requests[0];
}

describe('GeminiBackend identity reminder', () => {
  it('appends the reminder to the system instruction by default', async () => {
    const request = await run([
      { role: 'system', content: 'You are terse.' },
      { role: 'user', content: 'hi' },
    ]);

    expect(request.config?.systemInstruction).toBe(`You are terse.\n\n${REMINDER}`);
  });

  // The pipeline can emit a second system layer after user turns (processFabFilesServer);
  // the adapter joins every layer, then appends once - never once per layer.
  it('appends one reminder after joining several system layers', async () => {
    const request = await run([
      { role: 'system', content: 'You are terse.' },
      { role: 'user', content: 'hi' },
      { role: 'system', content: 'Retrieved file content.' },
    ]);

    expect(request.config?.systemInstruction).toBe(`You are terse.\nRetrieved file content.\n\n${REMINDER}`);
  });

  it('sends the reminder as the whole system instruction when the caller supplied none', async () => {
    const request = await run([{ role: 'user', content: 'hi' }]);

    expect(request.config?.systemInstruction).toBe(REMINDER);
  });

  it('sends no system instruction when the reminder is omitted and the caller supplied none', async () => {
    const request = await run([{ role: 'user', content: 'hi' }], { omitIdentityReminder: true });

    expect(request.config?.systemInstruction).toBeUndefined();
  });

  it('sends the caller system text unappended when the reminder is omitted', async () => {
    const request = await run(
      [
        { role: 'system', content: 'You are terse.' },
        { role: 'user', content: 'hi' },
      ],
      {
        omitIdentityReminder: true,
      }
    );

    expect(request.config?.systemInstruction).toBe('You are terse.');
  });
});
