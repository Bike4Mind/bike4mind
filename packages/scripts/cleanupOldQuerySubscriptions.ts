#!/usr/bin/env tsx

import { QuerySubscription, connectDB, mongoose } from '@bike4mind/database';
import dayjs from 'dayjs';
import { confirm } from '@inquirer/prompts';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { Resource } from 'sst';

interface CleanupOptions {
  dryRun: boolean;
  olderThanDays: number;
  batchSize: number;
  interactive: boolean;
}

interface CleanupStats {
  totalFound: number;
  totalDeleted: number;
  batchesProcessed: number;
  deletionErrors: number;
  startTime: Date;
  endTime?: Date;
}

interface BatchResult {
  deletedCount: number;
  processingTimeMs: number;
  error?: Error;
}

class QuerySubscriptionCleaner {
  private options: CleanupOptions;
  private stats: CleanupStats;

  constructor(options: CleanupOptions) {
    this.options = options;
    this.stats = {
      totalFound: 0,
      totalDeleted: 0,
      batchesProcessed: 0,
      deletionErrors: 0,
      startTime: new Date(),
    };
  }

  private get cutoffDate(): Date {
    return dayjs().subtract(this.options.olderThanDays, 'days').toDate();
  }

  private get deleteFilter() {
    return { updatedAt: { $lt: this.cutoffDate } };
  }

  async execute(): Promise<CleanupStats> {
    try {
      await this.initialize();
      await this.analyzeDocuments();

      if (this.stats.totalFound === 0) {
        this.logInfo('✅ No old querySubscriptions found to clean up');
        return this.finalizeStats();
      }

      await this.displaySampleDocuments();

      if (this.options.interactive && !(await this.confirmExecution())) {
        this.logInfo('❌ Cleanup cancelled by user');
        return this.finalizeStats();
      }

      await this.processDeletion();
      this.displaySummary();

      return this.finalizeStats();
    } catch (error) {
      this.logError('💥 Error during cleanup:', error);
      throw error;
    }
  }

  private async initialize(): Promise<void> {
    this.logInfo('🧹 Starting QuerySubscription Cleanup');
    this.logInfo(`📅 Cutoff date: ${this.cutoffDate.toISOString()}`);
    this.logInfo(`⏰ Cleaning documents older than ${this.options.olderThanDays} days`);
    this.logInfo(`📊 Batch size: ${this.options.batchSize}`);
    this.logInfo(`🔍 Mode: ${this.options.dryRun ? 'DRY RUN' : 'LIVE DELETION'}`);
    this.logInfo('');
  }

  private async analyzeDocuments(): Promise<void> {
    this.logInfo('🔍 Analyzing documents...');
    this.stats.totalFound = await QuerySubscription.countDocuments(this.deleteFilter);
    this.logInfo(`📋 Found ${this.stats.totalFound} querySubscriptions to clean up`);
  }

  private async displaySampleDocuments(): Promise<void> {
    const sampleDocs = await QuerySubscription.find(this.deleteFilter)
      .select('collectionName queryId subscribers updatedAt')
      .limit(3)
      .lean();

    this.logInfo('\n📄 Sample documents to be cleaned:');
    sampleDocs.forEach((doc, index) => {
      const subscriberCount = Array.isArray(doc.subscribers) ? doc.subscribers.length : 0;
      const lastUpdated = dayjs(doc.updatedAt).format('YYYY-MM-DD HH:mm:ss');
      const queryIdPreview = doc.queryId.substring(0, 8) + '...';

      this.logInfo(
        `  ${index + 1}. Collection: ${doc.collectionName}, QueryId: ${queryIdPreview}, Subscribers: ${subscriberCount}, Last Updated: ${lastUpdated}`
      );
    });
    this.logInfo('');
  }

  private async confirmExecution(): Promise<boolean> {
    if (this.options.dryRun) return true;

    return await confirm({
      message: `⚠️  Are you sure you want to delete ${this.stats.totalFound} querySubscriptions? This action cannot be undone.`,
      default: false,
    });
  }

  private async processDeletion(): Promise<void> {
    this.logInfo(
      `${this.options.dryRun ? '🧪' : '🗑️'} ${this.options.dryRun ? 'Simulating' : 'Processing'} deletion in batches...`
    );

    let remainingCount = this.stats.totalFound;

    while (remainingCount > 0) {
      const batchResult = await this.processBatch();

      if (batchResult.error) {
        this.stats.deletionErrors++;
        this.logError(`❌ Batch ${this.stats.batchesProcessed + 1} failed:`, batchResult.error);
      } else {
        this.stats.totalDeleted += batchResult.deletedCount;
        remainingCount -= batchResult.deletedCount;
      }

      this.stats.batchesProcessed++;
      this.logBatchProgress(batchResult);

      if (batchResult.deletedCount === 0) break;

      await this.delayBetweenBatches();
    }
  }

  private async processBatch(): Promise<BatchResult> {
    const startTime = Date.now();

    try {
      let deletedCount: number;

      if (this.options.dryRun) {
        const docs = await QuerySubscription.find(this.deleteFilter).limit(this.options.batchSize).select('_id').lean();
        deletedCount = docs.length;
      } else {
        const result = await QuerySubscription.deleteMany(this.deleteFilter);
        deletedCount = result.deletedCount || 0;
      }

      return {
        deletedCount,
        processingTimeMs: Date.now() - startTime,
      };
    } catch (error) {
      return {
        deletedCount: 0,
        processingTimeMs: Date.now() - startTime,
        error: error as Error,
      };
    }
  }

  private logBatchProgress(batchResult: BatchResult): void {
    const progress = Math.min((this.stats.totalDeleted / this.stats.totalFound) * 100, 100);
    const action = this.options.dryRun ? 'Would delete' : 'Deleted';

    this.logInfo(
      `  Batch ${this.stats.batchesProcessed}: ${action} ${batchResult.deletedCount} documents, Progress: ${progress.toFixed(1)}% (${batchResult.processingTimeMs}ms)`
    );
  }

  private async delayBetweenBatches(): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  private displaySummary(): void {
    const duration = this.stats.endTime ? dayjs(this.stats.endTime).diff(this.stats.startTime, 'second', true) : 0;

    this.logInfo('');
    this.logInfo('📊 Cleanup Summary:');
    this.logInfo(`  • Documents found: ${this.stats.totalFound}`);
    this.logInfo(`  • Documents ${this.options.dryRun ? 'that would be' : ''} deleted: ${this.stats.totalDeleted}`);
    this.logInfo(`  • Batches processed: ${this.stats.batchesProcessed}`);
    this.logInfo(`  • Errors encountered: ${this.stats.deletionErrors}`);
    this.logInfo(`  • Total time: ${duration.toFixed(2)}s`);

    if (this.options.dryRun) {
      this.logInfo('\n🧪 This was a dry run. No documents were actually deleted.');
      this.logInfo('💡 Run without --dry-run to perform actual cleanup.');
    } else {
      this.logInfo('\n✅ Cleanup completed successfully!');
    }
  }

  private finalizeStats(): CleanupStats {
    this.stats.endTime = new Date();
    return { ...this.stats };
  }

  private logInfo(message: string): void {
    console.log(message);
  }

  private logError(message: string, error?: unknown): void {
    console.error(message, error);
  }
}

class DatabaseManager {
  static async connect(): Promise<void> {
    console.log('🔌 Connecting to database...');
    const uri = process.env.MONGODB_URI || Resource.MONGODB_URI.value;
    if (!uri) {
      throw new Error('MONGODB_URI environment variable is required');
    }
    await connectDB(uri);
    console.log('✅ Database connected\n');
  }

  static async disconnect(): Promise<void> {
    console.log('\n🔌 Disconnecting from database...');
    await mongoose.disconnect();
    console.log('✅ Database disconnected');
  }
}

async function main(): Promise<void> {
  const argv = await yargs(hideBin(process.argv))
    .scriptName('cleanupOldQuerySubscriptions')
    .usage('$0 [options]', 'Clean up old querySubscriptions documents from the database')
    .option('dry-run', {
      type: 'boolean',
      default: false,
      description: 'Run without actually deleting documents',
      alias: 'd',
    })
    .option('days', {
      type: 'number',
      default: 60,
      description: 'Delete documents older than N days',
      alias: 'D',
    })
    .option('batch-size', {
      type: 'number',
      default: 1000,
      description: 'Process N documents per batch',
      alias: 'b',
    })
    .option('non-interactive', {
      type: 'boolean',
      default: false,
      description: 'Skip confirmation prompts',
      alias: 'y',
    })
    .check(argv => {
      if (argv.days <= 0) {
        throw new Error('Days must be a positive number');
      }
      if (argv['batch-size'] <= 0 || argv['batch-size'] > 10000) {
        throw new Error('Batch size must be between 1 and 10000');
      }
      return true;
    })
    .example([
      ['$0 --dry-run', 'Preview what would be deleted without making changes'],
      ['$0 --days 90 --batch-size 500', 'Delete documents older than 90 days in batches of 500'],
      ['$0 --days 30 --non-interactive', 'Delete documents older than 30 days without confirmation'],
      ['$0 -d -D 7', 'Dry run for documents older than 7 days'],
    ])
    .help()
    .version(false)
    .parse();

  const options: CleanupOptions = {
    dryRun: argv['dry-run'],
    olderThanDays: argv.days,
    batchSize: argv['batch-size'],
    interactive: !argv['non-interactive'],
  };

  try {
    await DatabaseManager.connect();

    const cleaner = new QuerySubscriptionCleaner(options);
    const result = await cleaner.execute();

    process.exit(result.deletionErrors > 0 ? 1 : 0);
  } catch (error) {
    console.error('💥 Fatal error:', error);
    process.exit(1);
  } finally {
    await DatabaseManager.disconnect();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
