import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from 'vitest';
import { b4mTools } from '../llm/tools';
import { buildProactiveMessageMessages, proactiveMessageTools } from './generateAndSend';
import type {
  IAgentDocument,
  IChatHistoryItem,
  ISessionAgentConfigDocument,
  ISessionDocument,
} from '@bike4mind/common';

/**
 * generateAndSendProactiveMessage has no harness (it needs an LLM, storage and every repository),
 * so the tool deps it hands generateTools are pinned at the source, like the agentExecutor wiring in
 * apps/workers/src/queueHandlers/agentExecutor.lakeWriteTools.e2e.test.ts.
 */
describe('generateAndSendProactiveMessage tool deps', () => {
  const source = readFileSync(join(__dirname, 'generateAndSend.ts'), 'utf8');

  // The tool map is structural, so it can be asserted without standing up the message run.
  it('never offers decide, which has no injected runner on this surface', () => {
    expect(Object.keys(b4mTools)).toContain('decide'); // non-vacuous: the registry still has it
    expect(Object.keys(proactiveMessageTools)).not.toContain('decide');
    expect(Object.keys(proactiveMessageTools)).toHaveLength(Object.keys(b4mTools).length - 1);
  });

  it('hands generateTools the filtered map rather than the whole registry', () => {
    expect(source).toMatch(/^\s+proactiveMessageTools, \/\/ tools: full server-side tool set/m);
    expect(source).not.toMatch(/^\s+b4mTools, \/\/ tools:/m);
  });

  // Optional on ToolContext.db, so dropping either typechecks and edit_image then refuses the
  // owner's own generated-image keys with only a logged warning.
  it('wires the generated-image owner lookup', () => {
    expect(source).toMatch(/quests: db\.quests,/);
    expect(source).toMatch(/sessions: \{ findAllByIds: db\.sessions\.findAllByIds\.bind\(db\.sessions\) \},/);
  });

  it('marks the turn as internal-origin', () => {
    expect(source).toMatch(/authOrigin: 'internal',/);
  });

  it('does not hand the tools the whole session repository', () => {
    // The whole repo would enable incrementImageCount for images no quest of this run holds.
    expect(source).not.toMatch(/sessions: db\.sessions,/);
  });

  it('meters the message completion but leaves tool-internal calls on the raw backend', () => {
    expect(source).toMatch(
      /const llm = meter \? meterCompletionBackend\(backend, meter, modelInfo, models\) : backend;/
    );
    expect(source).toMatch(/\.complete\(model, messages, completionOptions/);
    expect(source).toMatch(/\n\s+backend,\n\s+\{ web_search:/);
  });
});

describe('buildProactiveMessageMessages', () => {
  const buildMessages = (recentMessages: IChatHistoryItem[]) =>
    buildProactiveMessageMessages({
      agent: { name: 'Assistant' } as IAgentDocument,
      config: { proactiveMessaging: {} } as ISessionAgentConfigDocument,
      session: {} as ISessionDocument,
      recentMessages,
    });

  it('omits an early-stopped prompt while preserving completed and partial turns', () => {
    const messages = buildMessages([
      { prompt: 'completed question', status: 'done', replies: ['completed answer'] },
      { prompt: 'cancelled question', status: 'stopped', replies: [] },
      { prompt: 'partial question', status: 'stopped', replies: ['partial answer'] },
    ] as IChatHistoryItem[]);

    expect(messages.slice(1, -1)).toEqual([
      { role: 'user', content: 'completed question' },
      { role: 'assistant', content: 'completed answer' },
      { role: 'user', content: 'partial question' },
      { role: 'assistant', content: 'partial answer' },
    ]);
  });

  it('keeps an error reply stored on a stopped turn', () => {
    const messages = buildMessages([
      { prompt: 'failed question', status: 'stopped', replies: ['Request failed'] },
    ] as IChatHistoryItem[]);

    expect(messages.slice(1, -1)).toEqual([
      { role: 'user', content: 'failed question' },
      { role: 'assistant', content: 'Request failed' },
    ]);
  });
});
