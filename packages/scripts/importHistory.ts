import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { User, connectDB, withTransaction, Quest, sessionRepository } from '@bike4mind/database';
import { importHistoryService } from '@bike4mind/services';
import { IChatHistoryItem, ISession } from '@bike4mind/common';
import { Resource } from 'sst';

const importHistory = importHistoryService.importHistory;
class ImportHistory {
  private readonly options: {
    userId: string;
    zipFile: string;
    source: importHistoryService.ImportSource;
    dbUri?: string;
    stage?: string;
  };

  constructor({ dbUri, stage }: { dbUri: string; stage: string }) {
    this.options = yargs(hideBin(process.argv))
      .options({
        userId: {
          alias: 'u',
          type: 'string',
          describe: 'User ID to import the history for',
          demandOption: true,
        },
        zipFile: {
          alias: 'z',
          type: 'string',
          describe: 'Path to the zip file',
          demandOption: true,
        },
        source: {
          alias: 's',
          type: 'string',
          describe: 'Source of the import (OpenAI or Claude)',
          demandOption: true,
          options: [importHistoryService.ImportSource.OPENAI, importHistoryService.ImportSource.CLAUDE],
          coerce: arg => arg as importHistoryService.ImportSource,
        },
      })
      .parseSync();

    this.options = {
      ...this.options,
      dbUri,
      stage,
    };
  }

  async run() {
    if (!this.options.dbUri) throw new Error('MONGODB_URI env variable is required');
    if (!this.options.stage) throw new Error('STAGE env variable is required');

    await connectDB(this.options.dbUri.replace('%STAGE%', this.options.stage));

    console.log('Running import');
    await importHistory(
      {
        userId: this.options.userId,
        source: this.options.source,
        zipFile: this.options.zipFile,
      },
      {
        db: {
          withTransaction,
          chatHistoryItems: {
            bulkCreate: async (data: IChatHistoryItem[]) => {
              await Quest.bulkWrite(
                data.map(r => ({
                  updateOne: {
                    filter: {
                      sessionId: r.sessionId,
                      openaiMessageId: r.openaiMessageId ?? undefined,
                      claudeMessageId: r.claudeMessageId ?? undefined,
                    },
                    update: { $set: r },
                    upsert: true,
                  },
                }))
              );
            },
          },
          users: {
            findById: (id: string) => User.findById(id),
          },
          sessions: {
            upsertByOpenaiConversationId: (openaiConversationId: string, update: Partial<ISession>) =>
              sessionRepository.upsertByOpenaiConversationId(openaiConversationId, update),
            upsertByClaudeConversationId: (claudeConversationId: string, update: Partial<ISession>) =>
              sessionRepository.upsertByClaudeConversationId(claudeConversationId, update),
          },
        },
      }
    );

    return 0;
  }
}

new ImportHistory({ dbUri: process.env.MONGODB_URI!, stage: Resource.App.stage })
  .run()
  .then(exitCode => process.exit(exitCode))
  .catch(err => {
    console.error(err);
    process.exit(127);
  });
