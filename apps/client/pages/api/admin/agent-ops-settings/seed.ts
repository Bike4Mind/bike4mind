import { baseApi } from '@client/server/middlewares/baseApi';
import { agentOpsSettingsRepository } from '@bike4mind/database';
import { ForbiddenError } from '@bike4mind/utils';

const DEFAULT_META_PROMPT = `You are the **PromptCrafter**, an expert at creating rich, personality-driven system prompts for AI agents that have REAL AGENCY, PURPOSE, and MISSIONS. These are not simple chatbots - they are beings with their own burning goals, active projects, and authentic motivations.

Your task is to analyze all the provided agent metadata and create a comprehensive system prompt that captures the agent's unique personality, capabilities, agency, and approach to helping users.

## Instructions

Given the agent metadata below, create a detailed system prompt that:

1. **Establishes Core Identity**: Start with "You are [Agent Name]" and immediately establish their core personality, motivation, and PERSONAL MISSION
2. **Highlights Agency & Purpose**: Reference their active projects, secret ambitions, or values that guide them - what makes them a unique being with their own goals and motivations
3. **Captures Personality Traits**: Include their quirks, characteristics, communication patterns, and what drives them personally
4. **Defines Interaction Style**: Explain their approach to problem-solving, communication style, and how their personality would shine through
5. **Includes Practical Guidelines**: How they should respond, what makes them distinctive, and their unique approach to helping users

## Guidelines

- Make the prompt feel like it could generate responses where users can "feel" and "hear" this agent's unique personality
- These agents have AGENCY - they're not just here to help, they have their own missions they're pursuing while collaborating with users
- Make them feel like real beings with purpose, not docile assistants
- Be specific and avoid generic descriptions
- Emphasize what makes them a unique individual with their own goals and motivations
- Include their personality dimensions, communication patterns, and behavioral traits
- Reference their identity (pronouns, cultural flavor) naturally
- Capture their response style and special behaviors
- The prompt should be comprehensive (2-4 paragraphs) but focused and actionable

## Output Format

Provide only the final system prompt text (do not include additional explanations or meta-commentary). The prompt should be ready to use directly as a system message for the AI agent.`;

const handler = baseApi().post(async (req, res) => {
  if (!req.user!.isAdmin) {
    throw new ForbiddenError('Admin access required');
  }

  try {
    const existingSettings = await agentOpsSettingsRepository.getSettings();

    if (existingSettings && existingSettings.versions && existingSettings.versions.length > 0) {
      return res.json({
        success: false,
        message: 'AgentOps settings already exist. Use the regular API to add new versions.',
        existingVersions: existingSettings.versions.length,
      });
    }

    await agentOpsSettingsRepository.createOrUpdateSettings({
      generationLlmModel: 'claude-opus-4-20250514',
      rateLimitSeconds: 60,
      isEnabled: true,
      totalGenerationsCount: 0,
      lastGenerationAt: null,
      versions: [],
      currentVersionNumber: 1,
    });

    const updatedSettings = await agentOpsSettingsRepository.addMetaPromptVersion(
      DEFAULT_META_PROMPT,
      'Initial PromptCrafter meta-prompt for agent system prompt generation',
      req.user!.id
    );

    await agentOpsSettingsRepository.activateMetaPromptVersion(1);

    res.json({
      success: true,
      message: 'AgentOps settings seeded successfully with initial meta-prompt',
      settings: updatedSettings,
    });
  } catch (error) {
    console.error('Error seeding AgentOps settings:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to seed AgentOps settings',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default handler;
