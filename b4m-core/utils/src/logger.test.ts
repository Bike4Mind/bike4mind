import { describe, it, expect } from 'vitest';
import { Logger } from '@bike4mind/utils';
import type { ILogger, LogLevel } from '@bike4mind/utils';

// Compile-time type assertions for type-only re-exports
const _typeCheck: ILogger = {} as ILogger; // eslint-disable-line @typescript-eslint/no-unused-vars
const _levelCheck: LogLevel = 'info'; // eslint-disable-line @typescript-eslint/no-unused-vars

describe('@bike4mind/utils logger facade re-export', () => {
  it('re-exports Logger from @bike4mind/observability', () => {
    expect(typeof Logger).toBe('function');
    const logger = new Logger();
    expect(logger).toBeDefined();
  });
});
