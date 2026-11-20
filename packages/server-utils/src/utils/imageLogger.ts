import { Logger } from '@bike4mind/observability';

/**
 * Image generation logging utility, gated on NEXT_PUBLIC_VERBOSE_IMAGES. Errors always log.
 * Routes through the structured Logger.
 */

// Opt-in: only an explicit 'true' enables verbose image logging.
const isVerboseImages = process.env.NEXT_PUBLIC_VERBOSE_IMAGES === 'true';

interface ImageLogger {
  log: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  group: (label: string) => void;
  groupEnd: () => void;
  time: (label: string) => void;
  timeEnd: (label: string) => void;
  debug: (...args: unknown[]) => void;
  isEnabled: () => boolean;
}

const timers = new Map<string, number>();

/**
 * @deprecated To be deleted as we already have a Logger class in b4m-core
 */
export const imageLogger: ImageLogger = {
  log: (...args) => {
    if (isVerboseImages) Logger.info(...args);
  },
  info: (...args) => {
    if (isVerboseImages) Logger.info(...args);
  },
  warn: (...args) => {
    if (isVerboseImages) Logger.warn(...args);
  },
  // Always logged, even when verbose logging is off.
  error: (...args) => Logger.error(...args),
  group: label => {
    if (isVerboseImages) Logger.debug(`[group] ${label}`);
  },
  groupEnd: () => {},
  time: label => {
    if (isVerboseImages) timers.set(label, Date.now());
  },
  timeEnd: label => {
    const start = timers.get(label);
    if (!isVerboseImages || start === undefined) return;
    timers.delete(label);
    Logger.debug(label, { durationMs: Date.now() - start });
  },
  debug: (...args) => {
    if (isVerboseImages) Logger.debug(...args);
  },
  isEnabled: () => isVerboseImages,
};

export default imageLogger;
