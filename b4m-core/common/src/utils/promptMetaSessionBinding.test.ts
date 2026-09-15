import { describe, expect, it } from 'vitest';
import { materializePromptMetaSession, rebindPromptMetaSession } from './promptMetaSessionBinding';

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

  it('replaces an explicitly null session rather than spreading null into the result', () => {
    // A read path can hand back `session: null` where the field was never written. Spreading null
    // is a no-op in JS, so this lands as a well-formed block - but Mongoose rejects a null
    // subdocument outright, so it must not survive the rebind.
    const rebound = rebindPromptMetaSession(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- null is off-contract for the Zod type, on-contract for a raw read
      { session: null } as any,
      { sessionId: 'fork-1', userId: 'caller-1' }
    );

    expect(rebound?.session).toEqual({ id: 'fork-1', userId: 'caller-1' });
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

describe('materializePromptMetaSession', () => {
  it('builds a fresh promptMeta with a session block when none existed', () => {
    // The bike4mind#2004 bug: `quest.promptMeta = quest.promptMeta ?? {}` writers left `session`
    // out entirely, and that shape passes silently through update() (validators off).
    expect(materializePromptMetaSession(undefined, { sessionId: 'session-1', userId: 'user-1' })).toEqual({
      session: { id: 'session-1', userId: 'user-1' },
    });
    expect(materializePromptMetaSession(null, { sessionId: 'session-1', userId: 'user-1' })).toEqual({
      session: { id: 'session-1', userId: 'user-1' },
    });
  });

  it('adds the session block to an existing promptMeta that has none, preserving other fields', () => {
    const materialized = materializePromptMetaSession(
      { warnings: ['partial coverage'] },
      { sessionId: 'session-1', userId: 'user-1' }
    );

    expect(materialized).toEqual({
      warnings: ['partial coverage'],
      session: { id: 'session-1', userId: 'user-1' },
    });
  });

  it('re-asserts session on every call rather than trusting a prior write in the same turn', () => {
    const materialized = materializePromptMetaSession(
      { session: { id: 'session-1', userId: 'user-1' } },
      { sessionId: 'session-1', userId: 'user-1' }
    );

    expect(materialized.session).toEqual({ id: 'session-1', userId: 'user-1' });
  });

  it('does not mutate the source promptMeta', () => {
    const source = { warnings: ['partial coverage'] };

    materializePromptMetaSession(source, { sessionId: 'session-1', userId: 'user-1' });

    expect(source).toEqual({ warnings: ['partial coverage'] });
  });
});
