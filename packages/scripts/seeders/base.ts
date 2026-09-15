import { Logger } from '@bike4mind/observability';

export abstract class BaseSeeder {
  constructor(protected readonly logger: Logger) {
    this.logger = logger.withMetadata({
      seeder: this.constructor.name,
    });
  }

  abstract seed(): Promise<void>;
}
