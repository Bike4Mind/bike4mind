import { describe, expect, it } from 'vitest';
import type { AgentActivity } from '../activity';
import type { AgentState, AgentView } from '../roster';
import { innkeeperAct, innkeeperBubble } from './innkeeper';

const agent = (id: string, state: AgentState): AgentView => ({
  id,
  title: `Agent ${id}`,
  parentId: 'root',
  depth: 1,
  seedPrompt: '',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  model: 'm',
  state,
});

const tool = (name: string, target?: string): AgentActivity => ({ kind: 'tool', tool: name, detail: '', target });
const thinking: AgentActivity = { kind: 'phase', phase: 'thinking' };

describe('innkeeperAct', () => {
  it('polishes the bar while the parent is not processing', () => {
    expect(innkeeperAct({ status: 'done' }, [agent('a', 'working')])).toEqual({ pose: 'idle' });
    expect(innkeeperAct({}, [])).toEqual({ pose: 'idle' });
  });

  it('writes while posting quests, and while thinking before any agent exists', () => {
    expect(innkeeperAct({ status: 'processing', activity: tool('session_spawn') }, [agent('a', 'working')])).toEqual({
      pose: 'writing',
    });
    expect(innkeeperAct({ status: 'processing', activity: thinking }, [])).toEqual({ pose: 'writing' });
    expect(innkeeperAct({ status: 'processing' }, [])).toEqual({ pose: 'writing' });
  });

  it('walks to the agent a session_read or session_send names', () => {
    const agents = [agent('a', 'working'), agent('b', 'done')];
    expect(innkeeperAct({ status: 'processing', activity: tool('session_read', 'b') }, agents)).toEqual({
      pose: 'walking',
      target: 'b',
    });
    expect(innkeeperAct({ status: 'processing', activity: tool('session_send', 'a') }, agents)).toEqual({
      pose: 'walking',
      target: 'a',
    });
  });

  it('does not walk to a session that is not in the roster', () => {
    expect(
      innkeeperAct({ status: 'processing', activity: tool('session_read', 'stranger') }, [agent('a', 'working')])
    ).toEqual({ pose: 'idle' });
  });

  it('reads once every agent has settled and the parent is still processing', () => {
    const settled = [agent('a', 'done'), agent('b', 'failed'), agent('c', 'stopped'), agent('d', 'idle')];
    expect(innkeeperAct({ status: 'processing', activity: thinking }, settled)).toEqual({ pose: 'reading' });
    expect(innkeeperAct({ status: 'processing' }, [...settled, agent('e', 'needs-you')])).toEqual({ pose: 'idle' });
  });
});

describe('innkeeperBubble', () => {
  it("shows the parent's live activity while busy, and asks for the user when it needs them", () => {
    expect(innkeeperBubble({ status: 'processing', activity: tool('session_spawn') })).toBe('session_spawn');
    expect(innkeeperBubble({ status: 'processing', activity: thinking })).toBe('Thinking');
    expect(innkeeperBubble({ status: 'needs-action' })).toBe('Needs you!');
    expect(innkeeperBubble({ status: 'done', activity: thinking })).toBeUndefined();
    expect(innkeeperBubble({ status: 'processing' })).toBeUndefined();
  });
});
