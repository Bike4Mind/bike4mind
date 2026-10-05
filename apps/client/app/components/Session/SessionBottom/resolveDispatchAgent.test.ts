import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { IAgent } from '@bike4mind/common';
import { resolveDispatchAgent } from './resolveDispatchAgent';

const agent = (id: string, extra: Partial<IAgent> = {}) => ({ id, name: id, ...extra }) as IAgent;

describe('resolveDispatchAgent', () => {
  const picked = agent('picker-agent', { preferredModel: 'picker-model' });
  const mentioned = agent('mentioned-agent');
  const orchestration = agent('orchestration-agent', { allowedTools: ['web_search'] });

  it('runs as the picker-attached agent when nothing is @mentioned', () => {
    expect(resolveDispatchAgent(null, null, [picked])?.id).toBe('picker-agent');
  });

  it('takes the first attached agent when several are attached', () => {
    expect(resolveDispatchAgent(null, null, [picked, agent('second')])?.id).toBe('picker-agent');
  });

  it('lets a plain @mention override the picker', () => {
    expect(resolveDispatchAgent(null, mentioned, [picked])?.id).toBe('mentioned-agent');
  });

  it('lets the orchestration @mention override both', () => {
    expect(resolveDispatchAgent(orchestration, mentioned, [picked])?.id).toBe('orchestration-agent');
  });

  it('returns null with no agent at all, so the executor uses the synthetic profile', () => {
    expect(resolveDispatchAgent(null, null, [])).toBeNull();
  });
});

// Source-level for the same reason as `useSendMessage.skipAutoOffers.test.ts`: the hook is too
// wide to render, so this locks that the dispatch actually feeds the picker set through.
describe('useSendMessage - agent-mode dispatch uses resolveDispatchAgent', () => {
  const source = readFileSync(resolve(__dirname, 'useSendMessage.ts'), 'utf8');
  const start = source.indexOf('agentExecution.start({');
  const end = source.indexOf('});', start);
  const dispatch = source.slice(start, end);

  it('resolves the agent from the same set the Agents badge shows', () => {
    expect(source).toMatch(/const pickerAgents = currentSessionId \? sessionAgents : workBenchAgents;/);
    expect(source).toMatch(
      /const dispatchAgent = resolveDispatchAgent\(orchestrationAgent, mentionedAgent, pickerAgents\);/
    );
  });

  it('forwards that agent as agentId and model on agentExecution.start', () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(dispatch).toMatch(/^\s*agentId: dispatchAgent\?\.id,\s*$/m);
    expect(source).toMatch(/const dispatchModel = dispatchAgent\?\.preferredModel \?\? \(model as string\);/);
  });
});
