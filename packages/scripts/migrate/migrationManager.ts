import { AvailableMigrations } from './migrations';
import { Migration, connectDB, getDB } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { seeders } from '../seeders';
import { Resource } from 'sst';
import { Config } from '../utils/config';

export class MigrationManager {
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  async seed(): Promise<void> {
    this.logger.log(`Seeding database...`);

    await connectDB(Config.MONGODB_URI.replace('%STAGE%', Resource.App.stage), this.logger);

    for (const seeder of seeders) {
      const seederInstance = new seeder(this.logger);
      await seederInstance.seed();
    }
  }

  async up(target: number | null): Promise<void> {
    const lastMigration = await Migration.findOne().sort({ id: -1 });
    const migrations = AvailableMigrations.filter(m => !lastMigration || m.id > lastMigration.id)
      .filter(m => target === null || m.id <= target)
      .sort((a, b) => a.id - b.id);

    this.logger.log(`Total migrations known: ${AvailableMigrations.length}`);
    this.logger.log(`Last migration: ${lastMigration?.id || 'none'}`);
    this.logger.log(`Target migration: ${target === null ? 'all' : target}`);
    this.logger.log(`Migrations to run: ${migrations.length}`);
    this.logger.log('');

    for (const migration of migrations) {
      const logger = this.logger.withMetadata({
        migrationId: migration.id,
        migrationName: migration.name,
      });

      logger.log(`Running migration ${migration.id}: ${migration.name}`);
      try {
        await migration.up();
        await Migration.create({ id: migration.id, name: migration.name });
        logger.log(`Migration ${migration.id} ${migration.name} completed`);
      } catch (error: unknown) {
        logger.error(`Error running migration ${migration.id} ${migration.name}`);
        throw error;
      }
    }

    this.logger.log(`Migrations completed`);
  }

  async down(target: number | null): Promise<void> {
    const lastMigration = await Migration.findOne().sort({ id: -1 });
    const migrationsToRemove = AvailableMigrations.filter(m => lastMigration && m.id <= lastMigration.id)
      .filter(m => target === null || m.id > target)
      .sort((a, b) => b.id - a.id);

    for (const migration of migrationsToRemove) {
      const logger = this.logger.withMetadata({
        migrationId: migration.id,
        migrationName: migration.name,
      });

      logger.log(`Undoing migration ${migration.id}: ${migration.name}`);
      try {
        await migration.down();
        await Migration.deleteOne({ id: migration.id });
        logger.log(`Down-migration ${migration.id} ${migration.name} completed`);
      } catch (error: unknown) {
        logger.error(`Error reverting migration ${migration.id} ${migration.name}`);
        throw error;
      }
    }

    this.logger.log(`Migrations completed`);
  }

  async cleanup(): Promise<void> {
    this.logger.log(`Cleaning up database for stage: ${Resource.App.stage}`);

    // Safety check: only allow cleanup if MONGODB_URI contains %STAGE% placeholder
    if (!Resource.MONGODB_URI.value.includes('%STAGE%')) {
      this.logger.log('Skipping cleanup: Database URI does not contain %STAGE% placeholder');
      return;
    }

    await connectDB(Resource.MONGODB_URI.value.replace('%STAGE%', Resource.App.stage));
    const mongoose = getDB();
    if (!mongoose.connection.db) {
      throw new Error('Database connection not established');
    }

    this.logger.log('Dropping all collections...');
    const collections = await mongoose.connection.db.collections();

    for (const collection of collections) {
      this.logger.log(`Dropping collection: ${collection.collectionName}`);
      await collection.drop();
    }

    this.logger.log('Dropping database...');
    await mongoose.connection.db.dropDatabase();

    this.logger.log(`Database cleanup completed for stage: ${Resource.App.stage}`);
  }
}
