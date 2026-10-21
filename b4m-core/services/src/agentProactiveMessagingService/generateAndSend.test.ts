import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from 'vitest';
import { b4mTools } from '../llm/tools';
import { proactiveMessageTools } from './generateAndSend';

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

  it('keeps a prompt stopped before any reply out of the conversation context', () => {
    expect(source).toMatch(/if \(isStoppedBeforeReply\(msg\)\) continue;/);
  });

  it('does not hand the tools the whole session repository', () => {
    // The whole repo would enable incrementImageCount for images no quest of this run holds.
    expect(source).not.toMatch(/sessions: db\.sessions,/);
  });
});
