import { describe, it, expect } from 'vitest';
import { buildAgentPersonaPrompt } from './agentPersona';
import type { IAgent } from '../types/entities/AgentTypes';

// Minimal IAgent factory - the builder only reads name/description/systemPrompt/
// personality/capabilities/identity, so the rest is cast away.
function makeAgent(overrides: Partial<IAgent>): IAgent {
  return { id: 'a1', name: 'Nova', description: '', ...overrides } as IAgent;
}

describe('buildAgentPersonaPrompt', () => {
  it('uses the generated systemPrompt verbatim, then appends the character contract (priority path)', () => {
    const agent = makeAgent({
      systemPrompt: 'You are Nova, a stoic navigator.',
      // These would be composed by the fallback, but must be ignored here.
      description: 'ignored',
      personality: { majorMotivation: 'ignored' } as IAgent['personality'],
    });
    const prompt = buildAgentPersonaPrompt(agent);
    expect(prompt).toContain('You are Nova, a stoic navigator.');
    // The stored prompt is not mangled, and the stay-in-character contract follows it.
    expect(prompt.startsWith('You are Nova, a stoic navigator.')).toBe(true);
    expect(prompt).toContain('Stay in character as Nova');
    expect(prompt).not.toContain('description: ignored');
  });

  it('falls back to composing when systemPrompt is whitespace-only', () => {
    const agent = makeAgent({ systemPrompt: '   ', description: 'A helpful guide.' });
    const prompt = buildAgentPersonaPrompt(agent);
    expect(prompt).toContain('You are Nova.');
    expect(prompt).toContain('A helpful guide.');
  });

  it('emits core AND enhanced/agency personality fields, omitting empty ones', () => {
    const agent = makeAgent({
      personality: {
        majorMotivation: 'curiosity',
        // enhanced dimension
        humorStyle: 'dry wit',
        // agency & purpose dimension
        personalMission: 'map the unknown',
        // empty / whitespace fields must be skipped
        minorMotivation: '',
        quirk: '   ',
      } as IAgent['personality'],
    });
    const prompt = buildAgentPersonaPrompt(agent);
    expect(prompt).toContain('Your primary motivation is: curiosity');
    expect(prompt).toContain('Your sense of humor: dry wit');
    expect(prompt).toContain('Your personal mission: map the unknown');
    expect(prompt).not.toContain('You are also driven by');
    expect(prompt).not.toContain('Your unique quirk');
  });

  it('does not throw on malformed capabilities JSON and still builds the rest', () => {
    const agent = makeAgent({
      description: 'A guide.',
      capabilities: ['{ not valid json'],
    });
    expect(() => buildAgentPersonaPrompt(agent)).not.toThrow();
    const prompt = buildAgentPersonaPrompt(agent);
    expect(prompt).toContain('A guide.');
    expect(prompt).not.toContain('communication style');
  });

  it('parses well-formed capabilities for responseStyle and specialBehaviors', () => {
    const agent = makeAgent({
      capabilities: [JSON.stringify({ responseStyle: 'concise', specialBehaviors: ['cites sources', 'asks first'] })],
    });
    const prompt = buildAgentPersonaPrompt(agent);
    expect(prompt).toContain('Your communication style is concise.');
    expect(prompt).toContain('Your special behaviors include: cites sources, asks first.');
  });

  it('renders identity gender and pronouns, skipping prefer-not-to-say', () => {
    const agent = makeAgent({
      identity: {
        gender: 'non-binary',
        pronouns: { subject: 'they', object: 'them' },
      } as IAgent['identity'],
    });
    const prompt = buildAgentPersonaPrompt(agent);
    expect(prompt).toContain('Gender identity: non-binary');
    expect(prompt).toContain('Use they/them pronouns when referring to yourself');

    const hidden = makeAgent({
      identity: { gender: 'prefer-not-to-say' } as IAgent['identity'],
    });
    expect(buildAgentPersonaPrompt(hidden)).not.toContain('Gender identity');
  });

  it('uses the generic-assistant fallback when only the name is known', () => {
    const prompt = buildAgentPersonaPrompt(makeAgent({ name: 'Nova', description: '' }));
    expect(prompt).toContain('You are Nova.');
    expect(prompt).toContain('helpful AI assistant');
    // Always closes with the stay-in-character contract.
    expect(prompt).toContain('Stay in character as Nova');
  });
});
