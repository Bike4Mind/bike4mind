import { Logger, ILogger } from '@bike4mind/utils';

export function makeLogger(): ILogger {
  return new Logger('test');
}
