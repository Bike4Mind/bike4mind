import { IAgent, IAgentCapabilities } from '@bike4mind/common';

/**
 * Check if a tag/record already exists in a list of records (case-insensitive)
 * @param records - Array of existing records/tags to search through
 * @param newRecord - The new record/tag to check for existence
 * @returns True if the record exists (case-insensitive), false otherwise
 */
export const isTagExistInRecords = (records: string[], newRecord: string) => {
  return records.map(record => record.toLowerCase()).includes(newRecord.toLowerCase());
};

/**
 * Parse agent capabilities from string array format
 * @param agent The agent object containing capabilities as string array
 * @returns Parsed capabilities object or default values
 */
export const parseAgentCapabilities = (agent: IAgent | null): IAgentCapabilities => {
  if (!agent) {
    return {
      triggerWords: [],
      responseStyle: 'friendly',
      specialBehaviors: [],
    };
  }

  if (agent.capabilities && agent.capabilities.length > 0) {
    try {
      return JSON.parse(agent.capabilities[0]) as IAgentCapabilities;
    } catch (e) {
      console.error('Error parsing agent capabilities:', e);
    }
  }

  // Return default capabilities if parsing fails
  return {
    triggerWords: agent.triggerWords || [],
    responseStyle: 'friendly',
    specialBehaviors: [],
  };
};

/**
 * Parse @mentions from a message text
 * @param message The message text to parse
 * @returns Array of mentioned trigger words (without @ symbol)
 */
export const parseAgentMentions = (message: string): string[] => {
  // Match @word patterns, allowing letters, numbers, underscores, and hyphens
  const mentionRegex = /@([a-zA-Z0-9_-]+)/g;
  const mentions: string[] = [];
  let match;

  while ((match = mentionRegex.exec(message)) !== null) {
    const triggerWord = match[1].toLowerCase(); // Extract without @ and normalize case
    if (!mentions.includes(triggerWord)) {
      mentions.push(triggerWord);
    }
  }

  return mentions;
};

/**
 * Check if a message contains any agent mentions
 * @param message The message text to check
 * @returns True if the message contains @mentions
 */
export const hasAgentMentions = (message: string): boolean => {
  return parseAgentMentions(message).length > 0;
};

/**
 * Find agents that match the mentioned trigger words
 * @param mentionedWords Array of mentioned words (without @)
 * @param availableAgents Array of available agents
 * @returns Array of agents that match the mentions
 */
export const findMatchingAgents = (mentionedWords: string[], availableAgents: IAgent[]): IAgent[] => {
  if (mentionedWords.length === 0) return [];

  return availableAgents.filter(agent =>
    agent.triggerWords.some(trigger =>
      mentionedWords.some(mention => mention.toLowerCase() === trigger.toLowerCase().replace('@', ''))
    )
  );
};

/**
 * Serialize agent capabilities to string array format
 * @param capabilities Capabilities object to serialize
 * @returns String array containing stringified capabilities
 */
export const serializeAgentCapabilities = (capabilities: IAgentCapabilities): string[] => {
  return [JSON.stringify(capabilities)];
};

/**
 * Prepare agent data for API submission by converting capabilities
 * @param agentData Partial agent data that may contain capabilities in object format
 * @returns Agent data with capabilities properly formatted
 */
export const prepareAgentDataForApi = (agentData: Partial<IAgent>): Partial<IAgent> => {
  // Deep clone the data to avoid modifying the original
  const preparedData = JSON.parse(JSON.stringify(agentData)) as Partial<IAgent>;

  // Handle capabilities conversion if needed
  if (
    preparedData.capabilities &&
    typeof preparedData.capabilities === 'object' &&
    !Array.isArray(preparedData.capabilities)
  ) {
    // Convert capabilities object to string array
    const capabilitiesObj = preparedData.capabilities as unknown as IAgentCapabilities;
    preparedData.capabilities = serializeAgentCapabilities(capabilitiesObj);
  }

  return preparedData;
};
