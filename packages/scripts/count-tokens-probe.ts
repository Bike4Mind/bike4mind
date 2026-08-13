#!/usr/bin/env tsx

/**
 * Provider count_tokens probe for issue #810 (cold-turn prompt footprint).
 *
 * Sends the same representative basic-turn request to Anthropic's
 * `count_tokens` endpoint in three payload shapes - system-only, system+tools,
 * and no-tools - to size how much of the cached cold-turn prefix is driven by
 * tool presence (a provider-injected tool-use preamble) versus the system
 * prompt itself. This does not touch the DB or any running service; it calls
 * the Anthropic SDK directly with the same content the app authors.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=... pnpm --filter @bike4mind/scripts count-tokens-probe [model]
 *   Or: ANTHROPIC_API_KEY=... npx tsx packages/scripts/count-tokens-probe.ts [model]
 *
 * Paste the raw output into the issue/PR - see #810 acceptance item 1.
 */

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';
import { ARTIFACT_EMISSION_PROMPT, HELP_CENTER_PROMPT, ABSTENTION_PROMPT } from '@bike4mind/common';
import { b4mTools } from '@bike4mind/services/llm/tools';
import type { ToolContext } from '@bike4mind/services/llm/tools';

const DEFAULT_MODEL = 'claude-sonnet-4-5-20250929';

// The always-on system blocks a real basic chat turn composes (see
// ChatCompletionProcess.ts's systemPromptDetails assembly). Same content the
// app sends - not a synthetic stand-in - so the probe's numbers are real.
const SYSTEM_PROMPT = [ARTIFACT_EMISSION_PROMPT, HELP_CENTER_PROMPT, ABSTENTION_PROMPT].join('\n\n');

const USER_MESSAGE = 'What is the capital of France?';

// The four tools auto-added to every chat today per issue #810 (skill always;
// blog_* for an admin with blog integration). Only `.toolSchema` is read
// below - `.toolFn` is never invoked - so an empty stub context is safe here.
const stubContext = {} as unknown as ToolContext;

function buildToolSchemas() {
  const names = ['skill', 'blog_draft', 'blog_publish', 'blog_edit'] as const;
  return names.map(name => {
    const { toolSchema } = b4mTools[name].implementation(stubContext, {});
    const { parameters, strict, ...rest } = toolSchema;
    // Mirrors AnthropicBackend.formatTools() (anthropicBackend.ts:2270-2282):
    // `strict` is OpenAI-only and Anthropic rejects it.
    void strict;
    return { ...rest, input_schema: parameters };
  });
}

async function probe(model: string) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('Set ANTHROPIC_API_KEY to run this probe.');
    process.exit(1);
  }

  const client = new Anthropic({ apiKey });
  const tools = buildToolSchemas();
  const messages: MessageParam[] = [{ role: 'user', content: USER_MESSAGE }];

  const shapes: Array<{ label: string; params: Parameters<typeof client.messages.countTokens>[0] }> = [
    { label: 'system-only', params: { model, system: SYSTEM_PROMPT, messages } },
    { label: 'system+tools', params: { model, system: SYSTEM_PROMPT, messages, tools } },
    { label: 'no-tools', params: { model, messages } },
  ];

  console.log(`Probing ${model} with 3 payload shapes (user message: "${USER_MESSAGE}")\n`);

  const results: Record<string, number> = {};
  for (const { label, params } of shapes) {
    const { input_tokens } = await client.messages.countTokens(params);
    results[label] = input_tokens;
    console.log(`${label.padEnd(14)} input_tokens=${input_tokens}`);
  }

  const toolPresenceDelta = results['system+tools'] - results['system-only'];
  const authoredToolSchemaChars = JSON.stringify(tools).length;
  console.log(`\nsystem-only -> system+tools delta: ${toolPresenceDelta} tokens`);
  console.log(
    `Authored tool schema JSON: ${authoredToolSchemaChars} chars (~${Math.round(authoredToolSchemaChars / 4)} tokens by a rough 4-chars/token estimate)`
  );
  console.log('Any gap between the delta and the authored-schema estimate is the provider-injected tool-use preamble.');
}

probe(process.argv[2] || DEFAULT_MODEL).catch(err => {
  console.error('Probe failed:', err);
  process.exit(1);
});
