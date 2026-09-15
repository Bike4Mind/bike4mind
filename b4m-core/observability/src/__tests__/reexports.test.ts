import { describe, it, expect } from 'vitest';
import * as observability from '../index';

// Compile-time type assertions for type-only exports (invisible to Object.keys())
import type { ILogger, LogLevel } from '../index';
const _typeCheck: ILogger = {} as ILogger; // eslint-disable-line @typescript-eslint/no-unused-vars
const _levelCheck: LogLevel = 'info'; // eslint-disable-line @typescript-eslint/no-unused-vars

describe('@bike4mind/observability re-exports', () => {
  it('exports Logger as a constructor function', () => {
    expect(Object.keys(observability)).toContain('Logger');
    expect(typeof observability.Logger).toBe('function');
    const logger = new observability.Logger();
    expect(logger).toBeDefined();
  });
});
