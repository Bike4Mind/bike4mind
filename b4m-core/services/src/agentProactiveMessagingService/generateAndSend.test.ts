import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from 'vitest';

/**
 * generateAndSendProactiveMessage has no harness (it needs an LLM, storage and every repository),
 * so the tool deps it hands generateTools are pinned at the source, like the agentExecutor wiring in
 * apps/client/server/queueHandlers/agentExecutor.lakeWriteTools.e2e.test.ts.
 */
describe('generateAndSendProactiveMessage tool deps', () => {
  const source = readFileSync(join(__dirname, 'generateAndSend.ts'), 'utf8');

  // Optional on ToolContext.db, so dropping either typechecks and edit_image then refuses the
  // owner's own generated-image keys with only a logged warning.
  it('wires the generated-image owner lookup', () => {
    expect(source).toMatch(/quests: db\.quests,/);
    expect(source).toMatch(/sessions: \{ findAllByIds: db\.sessions\.findAllByIds\.bind\(db\.sessions\) \},/);
  });

  it('does not hand the tools the whole session repository', () => {
    // The whole repo would enable incrementImageCount for images no quest of this run holds.
    expect(source).not.toMatch(/sessions: db\.sessions,/);
  });
});
