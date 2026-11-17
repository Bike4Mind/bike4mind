import { describe, expect, it } from 'vitest';
import { buildDeferredSystemMessage, buildToolStateText } from './ChatService';
import { appendLiveToolChange, declareDeferredTools, toolStateReminder } from './deferredTools';
import type { CompletionMessage } from './completions';
import { promptFootprint } from './promptFootprint';
import { toolsForRequest } from './tools/registry';

function fixture() {
  const project = '--- begin fixture instructions ---\nKeep required instructions.\n--- end fixture instructions ---';
  const skills = 'Available fixture skill: deterministic-code-check';
  const system = String(buildDeferredSystemMessage(undefined, project, skills).content);
  const text = buildToolStateText({
    roots: ['/fixture/project'],
    media: false,
    host: true,
    explore: true,
    mcpServers: [],
    dependencyLines: [],
    projectContext: true,
    browser: false,
    patchEdits: true,
    memory: false,
    ask: false,
    screen: false,
  });
  const offered = toolsForRequest({
    roots: ['/fixture/project'],
    media: false,
    host: true,
    explore: true,
    web: true,
    delegates: true,
    structuredTask: true,
  });
  const tools = declareDeferredTools(offered, [], new Set());
  return { project, skills, system, text, offered, tools };
}

describe('sanitized Desktop prompt footprint baseline', () => {
  it('names each estimated source and exports no raw content', () => {
    const { project, skills, system, text, tools } = fixture();
    const budgets = {
      system: 1200,
      project: 30,
      skills: 20,
      'tool-state': 2400,
      'loaded-tools': 650,
      'deferred-tools': 9500,
    };
    const report = promptFootprint({
      system: system.replace(project, '').replace(skills, ''),
      project,
      skills,
      'tool-state': text,
      'loaded-tools': JSON.stringify(tools.filter(tool => !tool.toolSchema.defer_loading)),
      'deferred-tools': JSON.stringify(tools.filter(tool => tool.toolSchema.defer_loading)),
    });
    for (const block of report) {
      expect(block.sha256, block.block).toMatch(/^[a-f0-9]{64}$/);
      expect(block.estimatedTokens, `${block.block} prompt block grew`).toBeLessThan(
        budgets[block.block as keyof typeof budgets]
      );
    }
    expect(JSON.stringify(report)).not.toContain('/fixture');
    expect(JSON.stringify(report)).not.toContain('Keep required instructions');
    expect(promptFootprint({ system })).toEqual(promptFootprint({ system }));
    if (process.env.B4M_PROMPT_BASELINE === '1')
      console.info(
        JSON.stringify({
          kind: 'offline-shape-only',
          report,
          providerUsage: null,
          cacheWritesByTtl: null,
          usdCost: null,
          attempts: null,
          acceptedOutcome: null,
        })
      );
  });

  it('measures avoided tool-state duplication without changing tool declarations or evidence', () => {
    const { text, tools } = fixture();
    const from = { tools: ['file_read'], text };
    const to = { tools: ['file_read', 'fixture_tool'], text };
    const wire: CompletionMessage[] = [
      { role: 'user', content: toolStateReminder(from) },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'fixture', name: 'file_read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'fixture', content: 'fixture evidence' }] },
    ];
    const legacy = structuredClone(wire);
    const originalTools = JSON.stringify(tools);
    appendLiveToolChange(wire, from, to);
    legacy[2].content = [...(legacy[2].content as unknown[]), { type: 'text', text: toolStateReminder(to) }];
    legacy.push(wire[3]);
    const before = promptFootprint({ history: JSON.stringify(legacy) })[0];
    const after = promptFootprint({ history: JSON.stringify(wire) })[0];
    expect(before.estimatedTokens - after.estimatedTokens, 'tool-state duplicate reduction').toBeGreaterThan(1000);
    expect(JSON.stringify(tools)).toBe(originalTools);
    expect(wire.slice(0, 3)).toEqual(
      legacy
        .slice(0, 2)
        .concat([
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'fixture', content: 'fixture evidence' }] },
        ])
    );
    if (process.env.B4M_PROMPT_BASELINE === '1')
      console.info(
        JSON.stringify({
          kind: 'tool-state-duplicate',
          before,
          after,
          avoidedCharacters: before.characters - after.characters,
          avoidedEstimatedTokens: before.estimatedTokens - after.estimatedTokens,
          providerCostReduction: null,
        })
      );
  });
});
