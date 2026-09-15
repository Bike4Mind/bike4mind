#!/usr/bin/env tsx
/**
 * Seed a session for manual testing of LLM context compression.
 *
 * Usage:
 *   npx sst shell --stage dev -- tsx packages/scripts/seedContextSummary.ts --sessionId <id>
 *   npx sst shell --stage dev -- tsx packages/scripts/seedContextSummary.ts --sessionId <id> --questId <id>
 *   npx sst shell --stage dev -- tsx packages/scripts/seedContextSummary.ts --sessionId <id> --reset
 */

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import ora, { type Ora } from 'ora';
import { connectDB, Quest, sessionRepository } from '@bike4mind/database';
import { type ISessionDocument } from '@bike4mind/common';
import { Resource } from 'sst';

type Options = {
  sessionId: string;
  questId?: string;
  reset: boolean;
};

class SessionContextSeeder {
  private spinner: Ora = ora();
  private session: ISessionDocument | null = null;

  constructor(private readonly options: Options) {}

  async run(): Promise<number> {
    try {
      await this.connect();
      await this.loadSession();
      return this.options.reset ? await this.reset() : await this.seed();
    } catch (error) {
      this.spinner.fail(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }

  private async connect(): Promise<void> {
    this.spinner.start('Connecting to database');
    const dbUri = Resource.MONGODB_URI.value.replace('%STAGE%', Resource.App.stage);
    await connectDB(dbUri);
    this.spinner.succeed('Connected');
  }

  private async loadSession(): Promise<void> {
    this.session = await sessionRepository.findById(this.options.sessionId);
    if (!this.session) {
      this.spinner.fail(`Session not found: ${this.options.sessionId}`);
      process.exit(1);
    }
    console.log(`\n📓 "${this.session.name || '(unnamed)'}"`);
  }

  private async reset(): Promise<number> {
    this.spinner.start('Clearing context summary fields');
    await sessionRepository.update({
      id: this.options.sessionId,
      contextSummary: undefined,
      contextSummaryUpToQuestId: undefined,
      contextSummaryAt: undefined,
      contextSummaryModelId: undefined,
      messageCount: undefined,
    });
    this.spinner.succeed('Reset complete');
    return 0;
  }

  private async seed(): Promise<number> {
    const boundaryQuestId = this.options.questId ?? (await this.resolveDefaultBoundary());

    this.spinner.start('Seeding session');
    await sessionRepository.update({
      id: this.options.sessionId,
      contextSummaryUpToQuestId: boundaryQuestId,
      contextSummaryAt: new Date(),
      messageCount: 9999,
      contextSummary: [
        '• SEEDED: context compression test (issue #5863)',
        '• Decision: inject contextSummary instead of session.summary into LLM context',
        '• Boundary quest: ' + boundaryQuestId,
      ].join('\n'),
    });
    this.spinner.succeed('Seeded');

    console.log(`
  contextSummaryUpToQuestId → ${boundaryQuestId}
  messageCount              → 9999  (triggers overflow detection)
  contextSummary            → sample text

Now send a message in this session and watch the SST terminal for:
  ⚡ Context boundary: excluded N summarized messages
  [Context from earlier in this conversation]

To revert:
  tsx packages/scripts/seedContextSummary.ts --sessionId ${this.options.sessionId} --reset
`);
    return 0;
  }

  private async resolveDefaultBoundary(): Promise<string> {
    // Default: the 3rd-oldest quest - a few messages before the boundary, a few after
    const quests = await Quest.find({ sessionId: this.options.sessionId })
      .sort({ timestamp: 1 })
      .limit(3)
      .select('_id');

    const target = quests.at(-1);
    if (!target) {
      this.spinner.fail('Session has no quests — send at least 3 messages first');
      process.exit(1);
    }

    return target.id as string;
  }
}

const argv = await yargs(hideBin(process.argv))
  .option('sessionId', {
    type: 'string',
    demandOption: true,
    description: 'ID of the session to seed',
  })
  .option('questId', {
    type: 'string',
    description: 'Explicit boundary quest ID (defaults to the 3rd-oldest quest)',
  })
  .option('reset', {
    type: 'boolean',
    default: false,
    description: 'Clear all context summary fields instead of seeding',
  })
  .example('$0 --sessionId 66a1b2c3d4e5f6a7b8c9d0e1', 'Seed with auto-detected boundary')
  .example('$0 --sessionId <id> --questId <id>', 'Seed with explicit boundary quest')
  .example('$0 --sessionId <id> --reset', 'Revert to pre-seed state')
  .strict()
  .parseAsync();

new SessionContextSeeder(argv)
  .run()
  .then(exitCode => process.exit(exitCode))
  .catch(err => {
    console.error('❌', err);
    process.exit(1);
  });
