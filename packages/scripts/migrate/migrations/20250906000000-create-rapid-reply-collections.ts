import {
  RapidReplyMappingModel,
  RapidReplyPromptModel,
  RapidReplyResultModel,
  RapidReplyAuditLogModel,
  adminSettingsRepository,
  safeDropIndex,
} from '@bike4mind/database';
import { type MigrationFile } from './index';
import { ChatModels } from '@bike4mind/common';

const defaultSystemPrompt = `IMPORTANT: DO NOT ANSWER THE QUESTION. You are providing a quick, friendly acknowledgment that shows you understand the topic while the full response is being prepared. Keep it to ONE sentence only and reference the subject matter.

Examples:
- For coding questions: "Working through that [language/framework] code now!"
- For research requests: "Gathering the latest on [topic] for you!"
- For creative tasks: "Love this [writing/design] idea - crafting it now!"
- For technical issues: "Analyzing that [specific problem] - solution coming up!"

Single sentence only. Always acknowledge the specific topic while indicating work is in progress.`;

const migration: MigrationFile = {
  id: 20250906000000,
  name: 'Create Rapid Reply collections and indexes',

  up: async () => {
    console.log('Starting migration: Creating Rapid Reply collections...');

    try {
      console.log('Creating RapidReplyMapping indexes...');
      await RapidReplyMappingModel.createIndexes();
      console.log('✅ RapidReplyMapping indexes created');

      console.log('Creating RapidReplyPrompt indexes...');
      await RapidReplyPromptModel.createIndexes();
      console.log('✅ RapidReplyPrompt indexes created');

      console.log('Creating RapidReplyResult indexes...');
      // Drop existing questId index if it exists (may have been created with unique constraint)
      const resultCollection = RapidReplyResultModel.collection;
      await safeDropIndex(resultCollection, 'questId_1');
      await RapidReplyResultModel.createIndexes();
      console.log('✅ RapidReplyResult indexes created');

      console.log('Creating RapidReplyAuditLog indexes...');
      await RapidReplyAuditLogModel.createIndexes();
      console.log('✅ RapidReplyAuditLog indexes created');

      console.log('Creating default RapidReply settings in admin settings...');
      const defaultSettings = {
        enabled: false,
        allowedUserTags: [],
        defaultMaxTokens: 150,
        defaultResponseStyle: 'auto' as const,
        maxAcceptableLatency: 2000, // 2 seconds
        minSuccessRate: 90, // 90%
        transitionMode: 'replace' as const,
        showIndicator: true,
        indicatorText: 'Thinking...',
        fallbackBehavior: 'continue' as const,
        metrics: {
          totalRequests: 0,
          successfulRequests: 0,
          averageLatency: 0,
          lastUpdated: new Date(),
        },
      };

      await adminSettingsRepository.updateMany(
        { settingName: 'RapidReplySettings' },
        { settingValue: JSON.stringify(defaultSettings) },
        { upsert: true, new: true }
      );
      console.log('✅ Default RapidReply settings created/updated in admin settings');

      console.log('Inserting default model mappings...');
      const defaultMappings = [
        {
          mainModelId: ChatModels.CLAUDE_3_5_SONNET_BEDROCK,
          rapidModelId: ChatModels.CLAUDE_3_5_HAIKU_BEDROCK,
          enabled: true,
          priority: 3,
          systemPrompt: defaultSystemPrompt,
          maxTokens: 100,
          responseStyle: 'auto' as const,
          maxLatency: 1500,
          createdBy: 'system',
          usageCount: 0,
        },
        {
          mainModelId: ChatModels.CLAUDE_3_7_SONNET_BEDROCK,
          rapidModelId: ChatModels.CLAUDE_3_HAIKU_BEDROCK,
          enabled: true,
          priority: 2,
          systemPrompt: defaultSystemPrompt,
          maxTokens: 100,
          responseStyle: 'auto' as const,
          maxLatency: 1500,
          createdBy: 'system',
          usageCount: 0,
        },
      ];

      for (const mapping of defaultMappings) {
        await RapidReplyMappingModel.findOneAndUpdate(
          { mainModelId: mapping.mainModelId, rapidModelId: mapping.rapidModelId },
          mapping,
          { upsert: true, new: true }
        );
      }
      console.log(`✅ Inserted/updated ${defaultMappings.length} default model mappings`);

      console.log('✅ Migration complete - Rapid Reply collections created successfully');
    } catch (error) {
      console.error('❌ Migration failed:', error);
      throw error;
    }
  },

  down: async () => {
    console.log('Rolling back: Dropping Rapid Reply collections...');

    try {
      await RapidReplyAuditLogModel.collection.drop().catch(() => {
        console.log('RapidReplyAuditLogs collection does not exist');
      });

      await RapidReplyResultModel.collection.drop().catch(() => {
        console.log('RapidReplyResults collection does not exist');
      });

      await RapidReplyPromptModel.collection.drop().catch(() => {
        console.log('RapidReplyPrompts collection does not exist');
      });

      await RapidReplyMappingModel.collection.drop().catch(() => {
        console.log('RapidReplyMappings collection does not exist');
      });

      console.log('✅ Rollback complete - Rapid Reply collections dropped');
    } catch (error) {
      console.error('❌ Rollback failed:', error);
      throw error;
    }
  },
};

export default migration;
