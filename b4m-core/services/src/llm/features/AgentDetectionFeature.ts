import {
  IChatHistoryItemDocument,
  ISessionDocument,
  IMessage,
  ModelInfo,
  QuestMasterParamsSchema,
  detectAgentMentions,
  buildAgentPersonaPrompt,
} from '@bike4mind/common';
import { EmbeddingFactory } from '@bike4mind/utils';
import { IAgent } from '@bike4mind/common';
import { ChatCompletionFeature, ChatCompletionContext } from '../ChatCompletionFeatures';
import { z } from 'zod';

export class AgentDetectionFeature implements ChatCompletionFeature {
  constructor(private service: ChatCompletionContext) {
    this.service.logger.log('🔍 AgentDetectionFeature initialized');
  }

  async onComplete(args: {
    quest: IChatHistoryItemDocument;
    session: ISessionDocument;
    messages: IMessage[];
    questMaster: z.infer<typeof QuestMasterParamsSchema> | undefined;
  }): Promise<void> {
    // No cleanup needed
  }

  async beforeDataGathering(args: {
    quest: IChatHistoryItemDocument & { _agentsToProcess?: IAgent[] };
    session: ISessionDocument;
    startParams: any;
    llm: any;
    model: string;
    message: string;
    historyCount: number;
    fabFileIds: string[];
    questId: string;
    questMaster?: any;
  }): Promise<{ shouldContinue: boolean }> {
    const { message, quest, session } = args;

    this.service.logger.log(`🚨🚨🚨 AGENT DETECTION: Message="${message}"`);

    // Check for attached agents in the session or quest
    const attachedAgentIds = quest.agentIds || session.agentIds || [];
    this.service.logger.log(`🚨 Attached agents: ${attachedAgentIds.length} - IDs: ${attachedAgentIds.join(', ')}`);

    // Check for @mentions if no attached agents
    const mentions = await this.detectMentions(message);
    this.service.logger.log(`🚨 Detected mentions: ${JSON.stringify(mentions)}`);

    let agentsToProcess: IAgent[] = [];

    // Get attached agents
    if (attachedAgentIds.length > 0) {
      const attachedAgents = await Promise.all(
        attachedAgentIds.map(agentId => this.service.db.agents.findById(agentId))
      );
      agentsToProcess = attachedAgents.filter(agent => agent !== null);
      this.service.logger.log(`🔍 Found ${agentsToProcess.length} valid attached agents`);

      // Log agent details including system prompt availability
      agentsToProcess.forEach(agent => {
        this.service.logger.log(`📋 Agent "${agent.name}" (${agent.id}):`);
        this.service.logger.log(`   - Has system prompt: ${!!agent.systemPrompt}`);
        if (agent.systemPrompt) {
          this.service.logger.log(`   - System prompt preview: ${agent.systemPrompt.substring(0, 100)}...`);
        }
        this.service.logger.log(`   - Has personality: ${!!agent.personality}`);
        this.service.logger.log(`   - Trigger words: ${agent.triggerWords?.join(', ') || 'none'}`);
      });
    }

    // Get mentioned agents (if no attached agents)
    if (agentsToProcess.length === 0 && mentions.length > 0) {
      // Search for trigger words both with and without @ prefix for flexibility
      const triggerWordsToSearch = mentions.flatMap(mention => [
        `@${mention}`, // Try with @ (e.g., "@coffee")
        mention, // Try without @ (e.g., "coffee")
      ]);

      this.service.logger.log(`🚨 SEARCHING for trigger words: ${triggerWordsToSearch.join(', ')}`);

      const mentionedAgents = await this.service.db.agents.findByTriggerWords(
        triggerWordsToSearch,
        this.service.user.id
      );

      agentsToProcess = mentionedAgents;
      this.service.logger.log(
        `🚨 FOUND ${agentsToProcess.length} agents: ${mentionedAgents.map(a => a.name).join(', ')}`
      );
    }

    if (agentsToProcess.length > 0) {
      this.service.logger.log(
        `🔍 Will process ${agentsToProcess.length} agents through normal LLM flow with agent context`
      );
      // Store agents for use in getContextMessages
      quest._agentsToProcess = agentsToProcess;

      // Persist summoned agents onto the session so the Agents toggle reflects
      // them. An @mention otherwise only sets quest.agentIds (per-message
      // attribution); the session toggle reads session.agentIds and stays off
      // until the user flips it manually. The client-side attach is skipped on
      // the first message of a brand-new session (no session id yet), so doing
      // it here closes that gap for every path.
      const alreadyAttached = new Set(session.agentIds ?? []);
      const idsToAttach = agentsToProcess.map(agent => agent.id).filter(id => !alreadyAttached.has(id));
      for (const agentId of idsToAttach) {
        try {
          await this.service.db.sessions.attachAgent(session.id, agentId);
          // Keep the in-memory session consistent for any downstream features.
          session.agentIds = [...(session.agentIds ?? []), agentId];
        } catch (error) {
          this.service.logger.warn(`Failed to attach agent ${agentId} to session ${session.id}: ${error}`);
        }
      }
    } else {
      this.service.logger.log('🔍 No agents to process, continuing with normal flow');
    }

    // Always continue with normal processing - agents will add their context via getContextMessages
    return { shouldContinue: true };
  }

  async getContextMessages(
    quest: IChatHistoryItemDocument & { _agentsToProcess?: IAgent[] },
    embeddingFactory: EmbeddingFactory,
    message: string,
    maxTokens: number,
    modelInfo: ModelInfo
  ): Promise<IMessage[]> {
    // Get agents stored from beforeDataGathering
    const agentsToProcess: IAgent[] = quest._agentsToProcess || [];

    if (agentsToProcess.length === 0) {
      return [];
    }

    this.service.logger.log(`🚨 CREATING CONTEXT for ${agentsToProcess.length} agents`);

    // Store the agent IDs that are influencing this response
    // This will be used by the frontend to show which agents contributed
    quest.agentIds = agentsToProcess.map(agent => agent.id);
    this.service.logger.log(`🔍 Stored agent IDs in quest: ${quest.agentIds.join(', ')}`);

    const isSingleAgent = agentsToProcess.length === 1;

    const agentSystemPrompt = isSingleAgent
      ? this.buildAgentSystemPrompt(agentsToProcess[0])
      : this.buildCollaborativeSystemPrompt(agentsToProcess);

    if (isSingleAgent) {
      this.service.logger.log(
        `🚨 APPLYING AGENT "${agentsToProcess[0].name}" SYSTEM PROMPT (${agentSystemPrompt.length} chars)`
      );
    } else {
      this.service.logger.log(`🚨 APPLYING COLLABORATIVE SYSTEM PROMPT (${agentSystemPrompt.length} chars)`);
    }

    return [
      {
        role: 'system',
        content: agentSystemPrompt,
      },
    ];
  }

  private buildCollaborativeSystemPrompt(agents: IAgent[]): string {
    const parts: string[] = [];

    // Introduction for multiple agents
    const agentNames = agents.map(a => a.name).join(', ');
    parts.push(`You are responding as a collaborative team of AI agents: ${agentNames}.`);
    parts.push(`Each agent brings their unique perspective and personality to this response.`);

    // Add each agent's personality and characteristics
    agents.forEach((agent, index) => {
      const agentSection: string[] = [];

      agentSection.push(`\n**${agent.name}:**`);

      // PRIORITY: Use generated system prompt if available
      if (agent.systemPrompt && agent.systemPrompt.trim()) {
        this.service.logger.log(`🎯 Using generated system prompt for collaborative agent "${agent.name}"`);
        // For collaborative mode, we'll extract the essence and condense it
        agentSection.push(this.condensedSystemPromptForCollaboration(agent.systemPrompt));
      } else {
        // FALLBACK: Manual building for agents without generated system prompts
        this.service.logger.log(`⚙️ Building manual prompt section for collaborative agent "${agent.name}"`);

        // Add description
        if (agent.description && agent.description.trim()) {
          agentSection.push(agent.description);
        }

        // Add personality traits
        if (agent.personality) {
          const traits: string[] = [];

          if (agent.personality.majorMotivation) {
            traits.push(`Primary motivation: ${agent.personality.majorMotivation}`);
          }

          if (agent.personality.quirk) {
            traits.push(`Unique quirk: ${agent.personality.quirk}`);
          }

          if (agent.personality.flaw) {
            traits.push(`Characteristic flaw: ${agent.personality.flaw}`);
          }

          if (traits.length > 0) {
            agentSection.push(`- ${traits.join('. ')}`);
          }
        }

        // Add response style
        if (agent.capabilities && agent.capabilities.length > 0) {
          try {
            const capabilities = JSON.parse(agent.capabilities[0]);
            if (capabilities.responseStyle) {
              agentSection.push(`- Communication style: ${capabilities.responseStyle}`);
            }
          } catch (error) {
            this.service.logger.warn(`Failed to parse capabilities for agent ${agent.name}:`, error);
          }
        }
      }

      parts.push(agentSection.join(' '));
    });

    // Instructions for collaborative response
    parts.push(
      `\nRespond to the user's message by drawing from all these agent personalities and perspectives. Let each agent's unique voice and characteristics influence different aspects of your response. You may reference the different agents by name when their specific expertise or personality traits are most relevant to different parts of your answer.`
    );

    // Stay-in-character contract for collaborative mode. Mirrors the single-agent
    // contract in withCharacterContract (buildAgentPersonaPrompt) so multi-agent
    // summons do not break character on questions about their preferences or nature.
    parts.push(
      `\nStay in character as these agents throughout the conversation. Their interests, motivations, and traits are genuinely theirs: speak from them in the first person and let them shape what each agent brings up. If asked about their preferences, their nature, or whether they "really" have a self, answer from within character rather than breaking the fourth wall to disclaim it. Direct factual questions about capabilities or limits should still be answered honestly.`
    );

    return parts.join(' ');
  }

  /**
   * Condenses a full generated system prompt for use in collaborative mode
   * This extracts key personality traits while keeping it concise
   */
  private condensedSystemPromptForCollaboration(systemPrompt: string): string {
    // For collaborative mode, we want to extract the key traits without the full prompt
    // This is a simple approach - could be enhanced with AI summarization

    // Remove common prompt prefixes and instructions
    let condensed = systemPrompt
      .replace(/^You are /i, '')
      .replace(/Respond to.*?response\./gi, '')
      .replace(/Let your.*?through.*?\./gi, '');

    // Truncate if too long (keep collaborative prompts manageable)
    if (condensed.length > 300) {
      condensed = condensed.substring(0, 300) + '...';
    }

    return condensed.trim();
  }

  private buildAgentSystemPrompt(agent: IAgent): string {
    // Delegates to the shared, logger-free `buildAgentPersonaPrompt` in
    // `@bike4mind/common` so the classic chat path and the agent-executor /
    // Agent-mode path inject the IDENTICAL persona (the executor previously
    // injected none). Logging stays here where the service logger is available.
    if (agent.systemPrompt && agent.systemPrompt.trim()) {
      this.service.logger.log(`🎯 Using generated system prompt for agent "${agent.name}"`);
    } else {
      this.service.logger.log(
        `⚙️ Building manual system prompt for agent "${agent.name}" (no generated prompt available)`
      );
    }

    return buildAgentPersonaPrompt(agent);
  }

  async detectMentions(message: string): Promise<string[]> {
    // Delegates to the shared parser in `@bike4mind/common` so this stays in
    // lockstep with the client-side chat parser. The old inline `/@(\w+)/g`
    // dropped hyphens (so `@research-lead` extracted just `research`), which
    // caused the call below - `findByTriggerWords` - to miss the stored
    // `@research-lead` trigger word and fall through to plain chat with no
    // user feedback.
    return detectAgentMentions(message);
  }

  async routeToAgent(agentId: string, message: string): Promise<IMessage[]> {
    const agent = await this.service.db.agents.findById(agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found`);
    }

    const context = await this.getAgentContext(agent);
    return [...context.systemPrompts, { role: 'user', content: message }];
  }

  private async getAgentContext(agent: any) {
    return {
      systemPrompts: [],
      files: [],
    };
  }
}
