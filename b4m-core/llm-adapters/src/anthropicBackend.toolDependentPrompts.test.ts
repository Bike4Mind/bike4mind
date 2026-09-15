/**
 * When a turn hits the tool-call cap the backend recurses with `tools: undefined`, so any system
 * prompt that orders the model to use a tool ("you MUST use the image_generation tool") would arrive
 * on a call carrying no tools at all - and a model told to call a tool it does not have answers by
 * emitting the call as text. `stripToolDependentMessages` drops those prompts alongside the tools.
 *
 * Asserted against the params handed to the Anthropic client, where system messages land in
 * `apiParams.system`, so this covers the real wiring rather than the helper in isolation. The other
 * backends apply the same one-line strip at their own recursion sites.
 */

import { describe, it, expect } from 'vitest';
import { ChatModels } from '@bike4mind/common';
import type { IMessage } from '@bike4mind/common';
import { AnthropicBackend } from './anthropicBackend';
import type { ICompletionOptions, ICompletionOptionTools } from './backend';

type CapturedParams = Record<string, unknown>;

function buildBackend() {
  const backend = new AnthropicBackend('test-key');
  const captured: CapturedParams[] = [];
  (backend as unknown as { _api: unknown })._api = {
    messages: {
      create: async (apiParams: Record<string, unknown>) => {
        captured.push(apiParams);
        // Plain text answer: no tool_use block, so nothing recurses past this point.
        return { content: [{ type: 'text', text: 'Here you go.' }], usage: { input_tokens: 10, output_tokens: 5 } };
      },
    },
  };
  return { backend, getCaptured: () => captured };
}

const tool: ICompletionOptionTools = {
  toolSchema: {
    name: 'image_generation',
    description: 'Generate an image.',
    parameters: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] },
  },
  toolFn: async () => 'generated',
};

const IMAGE_PROMPT = 'When the user requests an image, you MUST use the image_generation tool to create it.';

const messages: IMessage[] = [
  { role: 'system', content: IMAGE_PROMPT, requiresTool: 'image_generation' },
  { role: 'system', content: 'Format replies as markdown.' },
  { role: 'user', content: 'draw me a picture of a cat' },
];

async function runComplete(backend: AnthropicBackend, options: Partial<ICompletionOptions>): Promise<void> {
  await backend.complete(ChatModels.CLAUDE_4_8_OPUS, messages, options, async () => undefined);
}

const systemText = (params: CapturedParams): string => JSON.stringify(params.system ?? '');

describe('AnthropicBackend drops tool-dependent prompts when it drops the tools', () => {
  // Control arm. Without it the assertion below could pass simply because the prompt never reached
  // apiParams.system in the first place.
  it('sends the prompt while the tool is still offered', async () => {
    const { backend, getCaptured } = buildBackend();

    await runComplete(backend, { stream: false, tools: [tool] });

    const calls = getCaptured();
    expect(calls).toHaveLength(1);
    expect(systemText(calls[0])).toContain('MUST use the image_generation tool');
    expect(calls[0].tools).toBeTruthy();
  });

  it('withholds the prompt on the tools-dropped recursion, keeping the tool-free ones', async () => {
    const { backend, getCaptured } = buildBackend();

    // maxToolCalls 0 puts the turn straight onto the cap-reached branch, which recurses with tools
    // removed - the same path a turn reaches after exhausting its tool budget.
    await runComplete(backend, { stream: false, tools: [tool], _internal: { maxToolCalls: 0 } });

    const calls = getCaptured();
    expect(calls).toHaveLength(1);
    expect(calls[0].tools).toBeFalsy();
    expect(systemText(calls[0])).not.toContain('MUST use the image_generation tool');
    // The unmarked system prompt is unrelated to tools and must survive.
    expect(systemText(calls[0])).toContain('Format replies as markdown');
  });
});
