import { describe, it, expect, vi } from 'vitest';
import {
  applySessionToolPolicy,
  runHasAttachments,
  DELEGATION_TOOLS,
  type SessionToolPolicyInput,
} from './agentExecutor.sessionToolPolicy';

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

// A representative agent toolbelt: a couple of surface tools plus the always-appended
// mission tools, with no content reader - the shape that made an attachment unreadable.
const TOOLBELT = ['optihashi_solve', 'web_search', 'create_mission', 'mission_status'];

describe('applySessionToolPolicy', () => {
  it('returns the toolbelt unchanged when the session carries no contract and nothing is attached', () => {
    const result = applySessionToolPolicy({
      toolNames: TOOLBELT,
      session: {},
      hasAttachments: false,
    });

    expect(result).toEqual(TOOLBELT);
  });

  it('does not union session.enabledTools', () => {
    // Deliberate: an orchestration profile narrows the toolbelt on purpose, and a curated
    // surface's session typically names its whole chat toolset, so unioning it back in would
    // dissolve every profile. Asserted so a future "parity" change has to argue with this test.
    // The input type has no `enabledTools` field at all; the cast stands in for a real session
    // document that does carry one, proving nothing here consumes it.
    const sessionWithEnabledTools = {
      enabledTools: ['image_generation', 'deep_research'],
    } as unknown as SessionToolPolicyInput['session'];

    const result = applySessionToolPolicy({
      toolNames: TOOLBELT,
      session: sessionWithEnabledTools,
      hasAttachments: false,
    });

    expect(result).not.toContain('image_generation');
    expect(result).not.toContain('deep_research');
  });

  describe('session.disabledTools (denylist)', () => {
    it('strips tools the session forbids', () => {
      const result = applySessionToolPolicy({
        toolNames: TOOLBELT,
        session: { disabledTools: ['web_search'] },
        hasAttachments: false,
      });

      expect(result).not.toContain('web_search');
      expect(result).toContain('optihashi_solve');
    });

    it('strips a forbidden tool even when the profile allowed it', () => {
      // The session contract is applied last on the chat path; this is that precedence.
      const result = applySessionToolPolicy({
        toolNames: ['web_search', 'optihashi_solve'],
        session: { disabledTools: ['web_search'] },
        profileDeniedTools: [],
        hasAttachments: false,
      });

      expect(result).toEqual(['optihashi_solve']);
    });

    it('strips the always-appended mission tools when the session forbids them', () => {
      // Mission tools are appended unconditionally upstream, so the denylist has to run after
      // that append or a "curated sources only" session cannot actually exclude them.
      const result = applySessionToolPolicy({
        toolNames: TOOLBELT,
        session: { disabledTools: ['create_mission', 'mission_status'] },
        hasAttachments: false,
      });

      expect(result).toEqual(['optihashi_solve', 'web_search']);
    });
  });

  describe('session.disableUserIntegrations', () => {
    it('denies the delegation tools so the loop cannot fan out on its own', () => {
      const result = applySessionToolPolicy({
        toolNames: [...TOOLBELT, ...DELEGATION_TOOLS],
        session: { disableUserIntegrations: true },
        hasAttachments: false,
      });

      for (const tool of DELEGATION_TOOLS) expect(result).not.toContain(tool);
      expect(result).toContain('optihashi_solve');
    });

    it('leaves delegation in place when the session does not suppress integrations', () => {
      const result = applySessionToolPolicy({
        toolNames: [...TOOLBELT, 'delegate_to_agent'],
        session: { disableUserIntegrations: false },
        hasAttachments: false,
      });

      expect(result).toContain('delegate_to_agent');
    });
  });

  describe('attachment-driven reader guarantee', () => {
    it('adds the content reader when the run carries attachments and the toolbelt lacks it', () => {
      const logger = makeLogger();

      const result = applySessionToolPolicy({
        toolNames: TOOLBELT,
        session: {},
        hasAttachments: true,
        logger,
      });

      expect(result).toContain('retrieve_knowledge_content');
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Added the content reader'),
        expect.objectContaining({ tool: 'retrieve_knowledge_content' })
      );
    });

    it('does not add the reader when nothing is attached', () => {
      const result = applySessionToolPolicy({
        toolNames: TOOLBELT,
        session: {},
        hasAttachments: false,
      });

      expect(result).not.toContain('retrieve_knowledge_content');
    });

    it('does not duplicate a reader the toolbelt already has', () => {
      const result = applySessionToolPolicy({
        toolNames: [...TOOLBELT, 'retrieve_knowledge_content'],
        session: {},
        hasAttachments: true,
      });

      expect(result.filter(t => t === 'retrieve_knowledge_content')).toHaveLength(1);
    });

    it('respects a profile that explicitly denies the reader, and does not log an addition', () => {
      // Explicit denial wins over the implicit add - the honest "cannot read them" preamble in
      // buildFirstIterationQuery is the intended outcome, not a silent re-add.
      const logger = makeLogger();

      const result = applySessionToolPolicy({
        toolNames: TOOLBELT,
        session: {},
        profileDeniedTools: ['retrieve_knowledge_content'],
        hasAttachments: true,
        logger,
      });

      expect(result).not.toContain('retrieve_knowledge_content');
      expect(logger.info).not.toHaveBeenCalled();
    });

    it('respects a session that explicitly denies the reader, and does not log an addition', () => {
      const logger = makeLogger();

      const result = applySessionToolPolicy({
        toolNames: TOOLBELT,
        session: { disabledTools: ['retrieve_knowledge_content'] },
        hasAttachments: true,
        logger,
      });

      expect(result).not.toContain('retrieve_knowledge_content');
      expect(logger.info).not.toHaveBeenCalled();
    });
  });

  it('preserves input order so the toolbelt stays stable across iterations', () => {
    const result = applySessionToolPolicy({
      toolNames: TOOLBELT,
      session: { disabledTools: ['web_search'] },
      hasAttachments: true,
    });

    // Original relative order kept, guaranteed reader appended at the end.
    expect(result).toEqual(['optihashi_solve', 'create_mission', 'mission_status', 'retrieve_knowledge_content']);
  });
});

describe('runHasAttachments', () => {
  it('is false when no ids are present anywhere', () => {
    expect(runHasAttachments({}, [])).toBe(false);
    expect(runHasAttachments({ messageFileIds: [], sessionFabFileIds: [] }, undefined)).toBe(false);
    expect(runHasAttachments({ messageFileIds: null, sessionFabFileIds: null }, null)).toBe(false);
  });

  it('is true for any single source', () => {
    expect(runHasAttachments({ messageFileIds: ['f1'] }, [])).toBe(true);
    expect(runHasAttachments({ sessionFabFileIds: ['f1'] }, [])).toBe(true);
    // Session knowledge alone counts: it is how a file attached to the notebook (rather than to
    // this message) reaches the agent, and it is the case that first surfaced this bug.
    expect(runHasAttachments({}, ['f1'])).toBe(true);
  });
});
