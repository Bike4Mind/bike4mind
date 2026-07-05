import { connectDB } from '@bike4mind/database';
import yargs from 'yargs';
import { AvailableMigrations } from './migrations';
import fs from 'fs';
import { MigrationManager } from './migrationManager';
import { Migration } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import path from 'path';
import { fileURLToPath } from 'url';
import { Config } from '../utils/config';
import { Resource } from 'sst';

export class MigrationTool extends MigrationManager {
  private options;
  private command: string;
  private args: (string | number)[];

  constructor(argv: string[]) {
    super(new Logger());

    this.options = yargs(argv)
      .command('up', 'Migrate up', y =>
        y.positional('target', {
          type: 'number',
          describe: 'Target migration ID: defaults to all migrations completed',
          default: null,
        })
      )
      .command('down', 'Migrate down', y =>
        y.positional('target', {
          type: 'number',
          describe: 'Target migration ID: defaults to last migration',
          default: null,
        })
      )
      .command('generate', 'Generate a new migration', y =>
        y.positional('name', {
          type: 'string',
          describe: 'Name of the migration',
          demandOption: true,
        })
      )
      .command('seed', 'Seed the database with data from ./seed')
      .command('cleanup', 'Drop all collections and clean up the database')
      .command('list', 'List available migrations', y =>
        y.options({
          pending: {
            type: 'boolean',
            describe: 'Only list pending migrations',
            default: false,
          },
          completed: {
            type: 'boolean',
            describe: 'Only list completed migrations',
            default: false,
          },
        })
      )
      .help()
      .wrap(72)
      .parseSync();

    this.command = this.options._[0] as string;
    this.args = this.options._.slice(1);

    if (this.options._.length === 0) {
      throw new Error('No command specified');
    }
  }

  async run(options: { dbUri: string; stage: string }): Promise<number> {
    if (options.dbUri === undefined) throw new Error('MONGODB_URI env variable is required');
    if (options.stage === undefined) {
      console.warn('STAGE env variable is not set.');
    }
    await connectDB(options.dbUri.replace('%STAGE%', options.stage));

    switch (this.command) {
      case 'up':
        await this.up((this.args[0] as number) ?? null);
        break;
      case 'down':
        await this.down((this.args[0] as number) ?? null);
        break;
      case 'generate':
        await this.generate((this.args as string[]).join(' '));
        break;
      case 'list':
        await this.list();
        break;
      case 'seed':
        await this.seed();
        break;
      case 'cleanup':
        await this.cleanup();
        break;

      default:
        throw new Error('Invalid command');
    }

    return 0;
  }

  async list(): Promise<void> {
    let pending = this.options.pending as boolean;
    let completed = this.options.completed as boolean;
    if (!pending && !completed) {
      pending = true;
      completed = true;
    }

    const completedMigrations = await Migration.find().sort({ id: 1 });
    const lastMigration = completedMigrations[completedMigrations.length - 1];
    const pendingMigrations = AvailableMigrations.filter(m => !lastMigration || m.id > lastMigration.id);

    if (pending) console.log(`Pending: ${JSON.stringify(pendingMigrations, null, 2)}\n`);
    if (completed) console.log(`Completed: ${JSON.stringify(completedMigrations, null, 2)}\n`);
  }

  async generate(name: string): Promise<void> {
    const now = new Date();
    // Concatenate the zero-padded timestamp with the name
    const id = [
      now.getFullYear().toString(),
      `0${now.getMonth() + 1}`.slice(-2),
      `0${now.getDate()}`.slice(-2),
      `0${now.getHours()}`.slice(-2),
      `0${now.getMinutes()}`.slice(-2),
      `0${now.getSeconds()}`.slice(-2),
    ].join('');
    const filename = `${id}_${name
      .replace(/[^a-z0-9]/gi, '-')
      .replace('--', '-')
      .toLowerCase()}.ts`;
    const template = `import { type MigrationFile } from './index';

const migration: MigrationFile = {
  id: ${id},
  name: '${name}',

  up: async () => {
  },

  down: async () => {
  }
};

export default migration;
`;
    const currentDirPath = path.dirname(fileURLToPath(import.meta.url));
    const migrationsPath = path.join(currentDirPath, 'migrations', filename);
    console.log(`Creating ./migrations/${filename}...`);
    fs.writeFileSync(migrationsPath, template);
    console.log(
      `\nDone.  Next write the up() and down() implementations and add the reference to ./migrations/index.ts`
    );
  }
}

new MigrationTool(process.argv.slice(2))
  .run({ dbUri: Config.MONGODB_URI!, stage: Resource.App.stage })
  .then((r: number) => process.exit(r))
  .catch(e => {
    console.error(e);
    process.exit(1);
  });
