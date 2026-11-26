import { describe, expect, it } from 'vitest';
import type { AgentActivity } from '../activity';
import type { AgentState, AgentView } from '../roster';
import { hostAct, hostBubble } from './host';

describe('host', () => {
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

  describe('hostAct', () => {
    it('polishes the bar while the parent is not processing', () => {
      expect(hostAct({ status: 'done' }, [agent('a', 'working')])).toEqual({ pose: 'idle' });
      expect(hostAct({}, [])).toEqual({ pose: 'idle' });
    });

    it('writes while posting quests, and while thinking before any agent exists', () => {
      expect(hostAct({ status: 'processing', activity: tool('session_spawn') }, [agent('a', 'working')])).toEqual({
        pose: 'writing',
      });
      expect(hostAct({ status: 'processing', activity: thinking }, [])).toEqual({ pose: 'writing' });
      expect(hostAct({ status: 'processing' }, [])).toEqual({ pose: 'writing' });
    });

    it('walks to the agent a session_read or session_send names', () => {
      const agents = [agent('a', 'working'), agent('b', 'done')];
      expect(hostAct({ status: 'processing', activity: tool('session_read', 'b') }, agents)).toEqual({
        pose: 'walking',
        target: 'b',
      });
      expect(hostAct({ status: 'processing', activity: tool('session_send', 'a') }, agents)).toEqual({
        pose: 'walking',
        target: 'a',
      });
    });

    it('does not walk to a session that is not in the roster', () => {
      expect(
        hostAct({ status: 'processing', activity: tool('session_read', 'stranger') }, [agent('a', 'working')])
      ).toEqual({ pose: 'idle' });
    });

    it('reads once every agent has settled and the parent is still processing', () => {
      const settled = [agent('a', 'done'), agent('b', 'failed'), agent('c', 'stopped'), agent('d', 'idle')];
      expect(hostAct({ status: 'processing', activity: thinking }, settled)).toEqual({ pose: 'reading' });
      expect(hostAct({ status: 'processing' }, [...settled, agent('e', 'needs-you')])).toEqual({ pose: 'idle' });
    });
  });

  describe('hostBubble', () => {
    it("shows the parent's live activity while busy, and asks for the user when it needs them", () => {
      expect(hostBubble({ status: 'processing', activity: tool('session_spawn') })).toBe('session_spawn');
      expect(hostBubble({ status: 'processing', activity: thinking })).toBe('Thinking');
      expect(hostBubble({ status: 'needs-action' })).toBe('Needs you!');
      expect(hostBubble({ status: 'done', activity: thinking })).toBeUndefined();
      expect(hostBubble({ status: 'processing' })).toBeUndefined();
    });
  });
});
