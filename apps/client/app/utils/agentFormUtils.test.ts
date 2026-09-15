import { describe, it, expect } from 'vitest';
import {
  generateDescriptionFromFormData,
  generateSystemPromptFromFormData,
  generateAgentName,
  deriveTriggerWords,
} from './agentFormUtils';

describe('generateDescriptionFromFormData (grammar)', () => {
  it('does not leave a dangling "<name> is," fragment when personality traits are empty', () => {
    // Repro: name + a responseStyle but no motivation/quirk previously produced
    // "Productivity Coach is, They communicate in a friendly manner."
    const out = generateDescriptionFromFormData({
      name: 'Productivity Coach',
      personality: {},
      capabilities: [{ responseStyle: 'friendly' }],
    });
    expect(out).not.toContain('is,');
    expect(out).not.toContain(', They');
    expect(out).toBe('Productivity Coach is an AI assistant. It communicates in a friendly manner.');
  });

  it('joins multiple personality clauses grammatically', () => {
    const out = generateDescriptionFromFormData({
      name: 'Atlas',
      personality: { majorMotivation: 'Curiosity', quirk: 'Love of puns' },
    });
    expect(out).toBe('Atlas is driven by curiosity and known for a love of puns.');
  });

  it('reads capabilities in both array and object shapes', () => {
    const objShape = generateDescriptionFromFormData({
      name: 'X',
      personality: {},
      capabilities: { responseStyle: 'concise' },
    });
    expect(objShape).toContain('It communicates in a concise manner.');
  });

  it('falls back to "This agent" when no/placeholder name', () => {
    expect(generateDescriptionFromFormData({ name: 'Unnamed Agent', personality: {} })).toMatch(/^This agent is/);
    expect(generateDescriptionFromFormData({ name: '', personality: {} })).toMatch(/^This agent is/);
  });

  it('prefers the generator-authored personality.description verbatim (Auto Fill path, review)', () => {
    // Auto Fill stores a complete, grammatical blurb here; re-deriving from the raw
    // "Label: explanation." fields is what leaked prefixes/double-periods into the description.
    const blurb = 'Swift Guide is a curious achiever with a love of puns.';
    const out = generateDescriptionFromFormData({
      name: 'Swift Guide',
      personality: { description: blurb, majorMotivation: 'achiever: driven by completing goals.' },
    });
    expect(out).toBe(blurb);
  });

  it('strips "Label: explanation." trait shapes in the field path (no leaked prefix / double period)', () => {
    const out = generateDescriptionFromFormData({
      name: 'Swift Guide',
      personality: { majorMotivation: 'achiever: driven by completing goals.', flaw: 'stubborn: resists change.' },
    });
    expect(out).not.toContain('achiever:'); // no leaked archetype prefix
    expect(out).not.toMatch(/\.\./); // no double period
    expect(out).toBe('Swift Guide is driven by achiever. It can sometimes be stubborn.');
  });
});

describe('generateSystemPromptFromFormData (no "Unnamed Agent" leak)', () => {
  it('uses the real name when provided', () => {
    const out = generateSystemPromptFromFormData({ name: 'Atlas', personality: {} });
    expect(out.startsWith('You are Atlas, an AI assistant.')).toBe(true);
  });

  it('never emits the "Unnamed Agent" placeholder', () => {
    expect(generateSystemPromptFromFormData({ name: 'Unnamed Agent', personality: {} })).not.toContain('Unnamed Agent');
    expect(generateSystemPromptFromFormData({ name: '', personality: {} })).toContain('You are an AI assistant.');
  });

  it('strips the "Label: explanation." prefix from interpolated traits (review)', () => {
    const out = generateSystemPromptFromFormData({
      name: 'Atlas',
      personality: { majorMotivation: 'catalyst: inspires others to act.', quirk: 'occasionally vain: self-praises.' },
    });
    expect(out).not.toContain('catalyst:');
    expect(out).not.toContain('occasionally vain:');
    expect(out).toContain('Your primary motivation is catalyst.');
    expect(out).toContain('You have a unique occasionally vain quirk.');
  });
});

describe('Auto Fill helpers', () => {
  it('generateAgentName returns a non-empty two-word name', () => {
    const name = generateAgentName();
    expect(name.trim().length).toBeGreaterThan(0);
    expect(name.split(' ').length).toBe(2);
  });

  it('deriveTriggerWords derives @-prefixed normalized words from the name', () => {
    // Trigger words are stored @-prefixed (validateTriggerWord / addTriggerWord).
    expect(deriveTriggerWords('Productivity Coach')).toEqual(['@productivity', '@coach']);
    // Short words (<=2 chars) are dropped.
    expect(deriveTriggerWords('AI Ops Helper')).toEqual(['@ops', '@helper']);
  });

  it('never returns [] for a non-empty name — falls back to short tokens (review)', () => {
    // An all-short name like "AI Go" must still yield trigger words, else Create stays disabled.
    expect(deriveTriggerWords('AI Go')).toEqual(['@ai', '@go']);
    expect(deriveTriggerWords('A')).toEqual(['@a']);
  });
});
