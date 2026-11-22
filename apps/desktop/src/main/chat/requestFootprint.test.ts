import { describe, expect, it } from 'vitest';
import { estimateTextTokens } from '@shared/contextLimit';
import type { CompletionMessage } from './completions';
import { changedPromptBlocks, promptFootprint } from '../../../test-utils/requestFootprint';
import type { WireTool } from './deferredTools';

const messages: CompletionMessage[] = [
  { role: 'system', content: 'Required fixture instructions.' },
  { role: 'user', content: 'Sanitized fixture task.' },
];
const tool: WireTool = {
  toolSchema: { name: 'fixture', description: 'Fixture tool.', parameters: { type: 'object', properties: {} } },
};

describe('assembled request footprint', () => {
  it.each(['Latin fixture.', '\u4eca\u5929 fixture \ud83d\ude00'])(
    'uses the shared Desktop estimator for %s',
    content => {
      const history: CompletionMessage[] = [{ role: 'user', content }];
      const block = promptFootprint(history, []).find(part => part.block === 'history')!;
      const serialized = JSON.stringify(history);
      expect(block.bytes).toBe(Buffer.byteLength(serialized));
      expect(block.estimatedTokens).toBe(estimateTextTokens(serialized));
      expect(block.estimatedTokens).not.toBe(Math.ceil(serialized.length / 3));
    }
  );

  it('exports only fixed block names, sizes, estimates and digests', () => {
    const result = promptFootprint(messages, [tool]);
    expect(result.map(part => part.block)).toEqual([
      'loaded-tools',
      'deferred-tools',
      'system',
      'history',
      'tool-changes',
    ]);
    for (const part of result) {
      expect(Object.keys(part).sort()).toEqual(['block', 'bytes', 'estimatedTokens', 'sha256']);
      expect(part.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(part.bytes).toBeGreaterThan(0);
      expect(part.estimatedTokens).toBeGreaterThan(0);
    }
    expect(JSON.stringify(result)).not.toContain('Required fixture');
    expect(JSON.stringify(result)).not.toContain('Sanitized fixture');
  });

  it('names history growth without blaming the stable tools or required instructions', () => {
    const before = promptFootprint(messages, [tool]);
    const after = promptFootprint([...messages, { role: 'assistant', content: 'Fixture result.' }], [tool]);
    expect(changedPromptBlocks(before, after)).toEqual(['history']);
    expect(after[3].estimatedTokens, 'history token estimate grows').toBeGreaterThan(before[3].estimatedTokens);
  });

  it('distinguishes changed instructions from changed tool definitions', () => {
    const before = promptFootprint(messages, [tool]);
    expect(
      changedPromptBlocks(before, promptFootprint([{ role: 'system', content: 'Revised.' }, messages[1]], [tool]))
    ).toEqual(['system']);
    expect(
      changedPromptBlocks(
        before,
        promptFootprint(messages, [
          {
            toolSchema: { ...tool.toolSchema, description: 'Revised schema.' },
          },
        ])
      )
    ).toEqual(['loaded-tools']);
  });

  it('attributes appended tool changes separately from the stable system instructions', () => {
    const after: CompletionMessage[] = [
      ...messages,
      {
        role: 'system',
        content: [{ type: 'tool_addition', tool: { type: 'tool_reference', name: 'fixture' } }],
      },
    ];
    expect(changedPromptBlocks(promptFootprint(messages, [tool]), promptFootprint(after, [tool]))).toEqual([
      'tool-changes',
    ]);
  });

  it('is deterministic across tool ordering and separates deferred schema bytes', () => {
    const deferred: WireTool = { toolSchema: { ...tool.toolSchema, name: 'other', defer_loading: true } };
    expect(promptFootprint(messages, [tool, deferred])).toEqual(promptFootprint(messages, [deferred, tool]));
    expect(changedPromptBlocks(promptFootprint(messages, [tool]), promptFootprint(messages, [deferred]))).toEqual([
      'loaded-tools',
      'deferred-tools',
    ]);
  });
});
