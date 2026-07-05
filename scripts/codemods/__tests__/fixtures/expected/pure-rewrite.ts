import { Logger, ILogger } from '@bike4mind/observability';

export function makeLogger(): ILogger {
  return new Logger('test');
}
