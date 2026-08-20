import { describe, expect, it } from 'vitest';
import { rebindPromptMetaSession } from './promptMetaSessionBinding';

describe('rebindPromptMetaSession', () => {
  it('supplies a session block when the source promptMeta carries none', () => {
    // The prod fork 500: several live writers materialize promptMeta with no session block, and
    // the store requires session.id/session.userId on the create() a copy goes through.
    const rebound = rebindPromptMetaSession(
      { warnings: ['partial coverage'] },
      {
        sessionId: 'fork-1',
        userId: 'caller-1',
      }
    );

    expect(rebound).toEqual({
      warnings: ['partial coverage'],
      session: { id: 'fork-1', userId: 'caller-1' },
    });
  });

  it('overwrites a stale session pointer inherited from the source session', () => {
    const rebound = rebindPromptMetaSession(
      { session: { id: 'source-session', userId: 'source-owner' } },
      { sessionId: 'clone-1', userId: 'caller-1' }
    );

    expect(rebound?.session).toEqual({ id: 'clone-1', userId: 'caller-1' });
  });

  it('carries over the fields that describe where the original turn ran', () => {
    const rebound = rebindPromptMetaSession(
      {
        session: {
          id: 'source-session',
          userId: 'source-owner',
          organizationId: 'org-1',
          projectId: 'project-1',
          agentId: 'agent-1',
          agentName: 'Agent 1',
        },
      },
      { sessionId: 'clone-1', userId: 'caller-1' }
    );

    expect(rebound?.session).toEqual({
      id: 'clone-1',
      userId: 'caller-1',
      organizationId: 'org-1',
      projectId: 'project-1',
      agentId: 'agent-1',
      agentName: 'Agent 1',
    });
  });

  it('does not mutate the source promptMeta', () => {
    const source = { session: { id: 'source-session', userId: 'source-owner' } };

    rebindPromptMetaSession(source, { sessionId: 'clone-1', userId: 'caller-1' });

    expect(source.session).toEqual({ id: 'source-session', userId: 'source-owner' });
  });

  it('leaves an absent promptMeta absent rather than inventing one', () => {
    expect(rebindPromptMetaSession(undefined, { sessionId: 'fork-1', userId: 'caller-1' })).toBeUndefined();
    expect(rebindPromptMetaSession(null, { sessionId: 'fork-1', userId: 'caller-1' })).toBeUndefined();
  });
});
