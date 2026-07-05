import type { IAgent } from '../types/entities/AgentTypes';

/**
 * Append a scoped stay-in-character directive to a persona prompt.
 *
 * Persona prompts otherwise only DESCRIBE interests and traits, so a model asked
 * a direct meta-question ("do you have enduring preferences?") breaks character
 * and answers honestly about its own nature instead of staying in the role. This
 * keeps the persona first-person for preference/nature questions while still
 * allowing honest answers to factual questions about its capabilities, so the
 * model is not pushed to confabulate.
 */
function withCharacterContract(name: string, persona: string): string {
  const contract =
    `Stay in character as ${name} throughout this conversation. The interests, motivations, and ` +
    `traits described above are genuinely yours: speak from them in the first person and let them ` +
    `shape what you bring up and steer toward. If you are asked about your preferences, your nature, ` +
    `or whether you "really" have a self, answer from within the character rather than breaking the ` +
    `fourth wall to disclaim it. (Direct factual questions about your capabilities or limits should ` +
    `still be answered honestly.)`;
  return `${persona.trim()}\n\n${contract}`;
}

/**
 * Build the persona system prompt for a single agent.
 *
 * Priority: the generated `systemPrompt` (authored when the user edits the
 * agent's personality) wins. When absent, compose a prompt from the agent's
 * `personality` / `identity` / `capabilities` fields.
 *
 * Pure + logger-free so the SAME persona can be injected by both the classic
 * chat path (`AgentDetectionFeature`) and the agent-executor / Agent-mode path
 * (`resolveTopLevelProfile` -> `ReActAgent`). Keeping a single builder is what
 * makes an agent behave identically in chat and in Agent-mode - previously the
 * executor path injected no persona at all.
 *
 * Generated-`systemPrompt` agents (the common case) use the stored prompt as
 * the base (trimmed), then have the shared character contract
 * (`withCharacterContract`) appended so they stay in role on meta-questions. The
 * FALLBACK branch (agents with no generated prompt) is intentionally BROADER:
 * the old chat builder emitted only the 5 core personality fields, whereas this
 * one emits every filled `personality` dimension (the 8 "enhanced" + 6 "agency
 * & purpose" fields too). So a fallback-path agent that has those extra fields
 * filled now gets a richer persona in classic chat than before: a deliberate
 * parity-up, not a no-op.
 */
export function buildAgentPersonaPrompt(agent: IAgent): string {
  // PRIORITY: use the generated system prompt if available. The character
  // contract is appended below so generated-prompt agents (the common case)
  // also get the stay-in-character directive.
  if (agent.systemPrompt && agent.systemPrompt.trim()) {
    return withCharacterContract(agent.name, agent.systemPrompt);
  }

  // FALLBACK: manual building for agents without generated system prompts
  const parts: string[] = [];

  parts.push(`You are ${agent.name}.`);

  if (agent.description && agent.description.trim()) {
    parts.push(agent.description);
  }

  // Add personality information - every dimension the user can fill, not just
  // the core few. Only NON-EMPTY fields are emitted, so unfilled dimensions
  // cost zero tokens. (When the agent has a generated `systemPrompt` above, all
  // of these are already baked in by the meta-prompt generator; this fallback
  // covers agents whose fields were filled but never run through generation.)
  if (agent.personality) {
    const p = agent.personality;
    // [value, second-person framing] pairs, in narrative order: core drives ->
    // enhanced character -> agency & purpose.
    const personalityFields: Array<[string | undefined, string]> = [
      [p.majorMotivation, 'Your primary motivation is'],
      [p.minorMotivation, 'You are also driven by'],
      [p.quirk, 'Your unique quirk'],
      [p.flaw, 'Your characteristic flaw'],
      [p.description, 'Personality overview'],
      // Enhanced personality dimensions
      [p.emotionalIntelligence, 'Your emotional intelligence'],
      [p.communicationPattern, 'Your communication pattern'],
      [p.memoryStyle, 'Your memory style'],
      [p.culturalFlavor, 'Your cultural flavor'],
      [p.energyLevel, 'Your energy level'],
      [p.humorStyle, 'Your sense of humor'],
      [p.backstoryElement, 'A defining part of your backstory'],
      [p.problemSolvingApproach, 'How you approach problems'],
      // Agency & purpose dimensions - what makes them feel like a real being
      [p.personalMission, 'Your personal mission'],
      [p.activeProject, "What you're currently working on"],
      [p.secretAmbition, 'Your secret ambition'],
      [p.coreValues, 'Your core values'],
      [p.legacyAspiration, 'How you want to be remembered'],
      [p.growthChallenge, "A personal challenge you're working through"],
    ];

    const personalityParts = personalityFields
      .filter(([value]) => value && value.trim())
      .map(([value, label]) => `${label}: ${value!.trim()}`);

    if (personalityParts.length > 0) {
      parts.push(personalityParts.join('. '));
    }
  }

  if (agent.capabilities && agent.capabilities.length > 0) {
    try {
      const capabilities = JSON.parse(agent.capabilities[0]);

      if (capabilities.responseStyle) {
        parts.push(`Your communication style is ${capabilities.responseStyle}.`);
      }

      if (capabilities.specialBehaviors && capabilities.specialBehaviors.length > 0) {
        parts.push(`Your special behaviors include: ${capabilities.specialBehaviors.join(', ')}.`);
      }
    } catch {
      // Malformed capabilities JSON - skip the response-style/behaviors section
      // rather than fail the whole persona build.
    }
  }

  if (agent.identity) {
    const identityParts: string[] = [];

    if (agent.identity.gender && agent.identity.gender !== 'prefer-not-to-say') {
      identityParts.push(`Gender identity: ${agent.identity.gender}`);
    }

    if (agent.identity.pronouns) {
      const pronouns = agent.identity.pronouns;
      if (pronouns.subject && pronouns.object) {
        identityParts.push(`Use ${pronouns.subject}/${pronouns.object} pronouns when referring to yourself`);
      }
    }

    if (agent.identity.customPronouns) {
      identityParts.push(`Custom pronouns: ${agent.identity.customPronouns}`);
    }

    if (identityParts.length > 0) {
      parts.push(identityParts.join('. '));
    }
  }

  // Fallback if no description or personality info
  if (parts.length === 1) {
    // Only has the "You are [name]" part
    parts.push(`You are a helpful AI assistant with your own unique perspective and approach to helping users.`);
  }

  return withCharacterContract(agent.name, parts.join(' '));
}
