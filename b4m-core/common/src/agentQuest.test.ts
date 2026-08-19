import { describe, it, expect } from 'vitest';
import {
  AGENT_QUEST_ID,
  AGENT_QUEST_MANIFEST,
  AGENT_QUEST_MANIFEST_PATH,
  AGENT_QUEST_MANIFEST_VERSION,
  AGENT_QUEST_MCP_URI,
} from './agentQuest';

describe('AGENT_QUEST_MANIFEST', () => {
  it('identifies itself as the agent-quest entry at the current version', () => {
    expect(AGENT_QUEST_MANIFEST.id).toBe('agent-quest');
    expect(AGENT_QUEST_ID).toBe('agent-quest');
    expect(AGENT_QUEST_MANIFEST.manifestVersion).toBe(AGENT_QUEST_MANIFEST_VERSION);
  });

  it('derives the MCP uri from the quest id', () => {
    expect(AGENT_QUEST_MCP_URI).toBe('b4m://agent-quest');
  });

  it('opens with a step that is already callable, so a reader is never stuck', () => {
    expect(AGENT_QUEST_MANIFEST.steps[0]).toMatchObject({
      id: 'read-the-manifest',
      status: 'available',
      endpoint: AGENT_QUEST_MANIFEST_PATH,
    });
  });

  it('covers the five steps of the quest in order', () => {
    expect(AGENT_QUEST_MANIFEST.steps.map(s => s.id)).toEqual([
      'read-the-manifest',
      'mcp-handshake',
      'scheduling-puzzle',
      'make-something',
      'sign-the-wall',
    ]);
  });

  // The load-bearing invariant of the whole document: an agent is told to call
  // `endpoint`, so a planned step carrying one would send it at a route that does
  // not exist yet. Flipping a step to `available` must come with its endpoint.
  it('gives an endpoint to exactly the available steps', () => {
    for (const step of AGENT_QUEST_MANIFEST.steps) {
      if (step.status === 'available') {
        expect(step.endpoint, `${step.id} is available but advertises no endpoint`).toBeTruthy();
      } else {
        expect(step.endpoint, `${step.id} is planned but advertises an endpoint`).toBeUndefined();
      }
    }
  });

  it('advertises only root-relative endpoints, so the document is origin-agnostic', () => {
    for (const step of AGENT_QUEST_MANIFEST.steps) {
      if (step.endpoint) expect(step.endpoint.startsWith('/')).toBe(true);
    }
  });

  it('describes every step to the visiting agent', () => {
    for (const step of AGENT_QUEST_MANIFEST.steps) {
      expect(step.title.length, `${step.id} has no title`).toBeGreaterThan(0);
      expect(step.instructions.length, `${step.id} has no instructions`).toBeGreaterThan(0);
    }
  });

  it('survives JSON serialization unchanged - both readers serve it as JSON', () => {
    expect(JSON.parse(JSON.stringify(AGENT_QUEST_MANIFEST))).toEqual(AGENT_QUEST_MANIFEST);
  });
});
