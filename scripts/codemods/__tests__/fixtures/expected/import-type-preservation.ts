/* eslint-disable */
import type { ILogger } from '@bike4mind/observability';
import { Logger, type LogLevel } from '@bike4mind/observability';

const log: ILogger = new Logger('test');
const level: LogLevel = 'info';
