import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { IAgent } from '@bike4mind/common';
import { pickerAttachedAgents, resolveDispatchAgent, resolveDispatchMaxIterations } from './resolveDispatchAgent';

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
    expect(source).toMatch(
      /const pickerAgents = pickerAttachedAgents\(currentSessionId, sessionAgents, workBenchAgents\);/
    );
    expect(source).toMatch(
      /const dispatchAgent = resolveDispatchAgent\(orchestrationAgent, mentionedAgent, pickerAgents\);/
    );
  });

  it('forwards that agent as agentId on agentExecution.start', () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(dispatch).toMatch(/^\s*agentId: dispatchAgent\?\.id,\s*$/m);
    expect(dispatch).toMatch(/^\s*model: dispatchModel,\s*$/m);
  });

  // A picker-only agent resolves as `dispatchAgent` (see 'runs as the picker-attached agent'), so
  // deriving the model from it would let its preferredModel override the composer selection.
  it('takes the model from an @mentioned agent only, never a picker-attached one', () => {
    const line = source.match(/^\s*const dispatchModel = (.*);$/m);
    expect(line?.[1]).toBe('(orchestrationAgent ?? mentionedAgent)?.preferredModel ?? (model as string)');
  });
});

describe('pickerAttachedAgents', () => {
  const sessionAgents = [agent('s1')];
  const workBenchAgents = [agent('w1')];

  it('uses the session agents once a session exists', () => {
    expect(pickerAttachedAgents('sess-1', sessionAgents, workBenchAgents)).toBe(sessionAgents);
  });

  it('uses the workbench agents before a session exists', () => {
    expect(pickerAttachedAgents(null, sessionAgents, workBenchAgents)).toBe(workBenchAgents);
  });
});

describe('resolveDispatchMaxIterations', () => {
  const caps = { quick: 3, medium: 7, very_thorough: 20 } as unknown as IAgent['maxIterations'];

  it('sends the cap for the agent default thoroughness', () => {
    expect(resolveDispatchMaxIterations(agent('a', { defaultThoroughness: 'quick', maxIterations: caps }))).toBe(3);
  });

  it('sends nothing for an agent with no default thoroughness, even with caps set', () => {
    expect(resolveDispatchMaxIterations(agent('a', { maxIterations: caps }))).toBeUndefined();
  });

  it('sends nothing when agentless', () => {
    expect(resolveDispatchMaxIterations(null)).toBeUndefined();
  });
});
