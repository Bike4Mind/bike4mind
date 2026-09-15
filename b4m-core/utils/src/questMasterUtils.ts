import { QuestMasterData } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';

interface QuestMasterMeta {
  type: 'narrative' | 'quest_plan';
  goal?: string;
  totalSteps: number;
}

export function extractQuestMasterData(reply: string, options: { logger?: Logger } = {}): QuestMasterData[] {
  const startMetaTag = '<!--QuestMasterMeta';
  const startQuestTag = '<!--QuestMaster';
  const endTag = '-->';
  const questMasterData: QuestMasterData[] = [];
  let questMasterMeta: QuestMasterMeta | null = null;

  // Extract the meta information
  const metaStartIndex = reply.indexOf(startMetaTag);
  if (metaStartIndex !== -1) {
    const metaEndIndex = reply.indexOf(endTag, metaStartIndex);
    if (metaEndIndex !== -1) {
      const metaContent = reply.slice(metaStartIndex + startMetaTag.length, metaEndIndex).trim();
      try {
        const jsonStartIndex = metaContent.indexOf('{');
        if (jsonStartIndex !== -1) {
          const jsonString = metaContent.slice(jsonStartIndex);
          questMasterMeta = JSON.parse(jsonString);
          options.logger?.log('Successfully parsed QuestMaster meta:', questMasterMeta);
        } else {
          options.logger?.warn('No JSON object found in QuestMasterMeta tag');
        }
      } catch (err) {
        options.logger?.error('Failed to parse QuestMaster meta JSON:', err, '\nContent:', metaContent);
        // Try to clean the JSON string and parse again
        try {
          const cleanedContent = metaContent.replace(/[\n\r]/g, '').trim();
          const jsonStartIndex = cleanedContent.indexOf('{');
          if (jsonStartIndex !== -1) {
            const jsonString = cleanedContent.slice(jsonStartIndex);
            questMasterMeta = JSON.parse(jsonString);
            options.logger?.log('Successfully parsed cleaned QuestMaster meta:', questMasterMeta);
          }
        } catch (cleanupErr) {
          options.logger?.error('Failed to parse cleaned QuestMaster meta JSON:', cleanupErr);
        }
      }
    } else {
      options.logger?.warn('QuestMasterMeta tag not properly closed');
    }
  } else {
    options.logger?.warn('No QuestMasterMeta tag found in reply');
  }

  // Then extract the quest data
  let startIndex = reply.indexOf(startQuestTag);
  while (startIndex !== -1) {
    const endIndex = reply.indexOf(endTag, startIndex);
    if (endIndex === -1) {
      options.logger?.warn('QuestMaster tag not properly closed');
      break;
    }

    const content = reply.slice(startIndex + startQuestTag.length, endIndex).trim();
    try {
      const jsonStartIndex = content.indexOf('{');
      if (jsonStartIndex !== -1) {
        const jsonString = content.slice(jsonStartIndex);
        const questData: QuestMasterData = JSON.parse(jsonString);

        questMasterData.push(questData);
        options.logger?.log('Successfully parsed QuestMaster data:', questData);
      } else {
        options.logger?.warn('No JSON object found in QuestMaster tag');
      }
    } catch (err) {
      // Try to clean the JSON string and parse again
      try {
        const cleanedContent = content.replace(/[\n\r]/g, '').trim();
        const jsonStartIndex = cleanedContent.indexOf('{');
        if (jsonStartIndex !== -1) {
          const jsonString = cleanedContent.slice(jsonStartIndex);
          const questData: QuestMasterData = JSON.parse(jsonString);
          questMasterData.push(questData);
          options.logger?.log('Successfully parsed cleaned QuestMaster data:', questData);
        }
      } catch (cleanupErr) {
        options.logger?.error('Failed to parse cleaned QuestMaster JSON:', cleanupErr);
      }
    }

    startIndex = reply.indexOf(startQuestTag, endIndex);
  }

  if (questMasterData.length > 0) {
    options.logger?.log('First quest data:', {
      title: questMasterData[0].title,
    });
  }

  return questMasterData;
}
