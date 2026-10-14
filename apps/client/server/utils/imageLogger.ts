/**
 * Image generation logging utility, gated on NEXT_PUBLIC_VERBOSE_IMAGES. Errors always log.
 */

// Environment-based configuration with flexible defaults
const isVerboseImages = (() => {
  // Check explicit setting first (takes priority)
  if (process.env.NEXT_PUBLIC_VERBOSE_IMAGES === 'true') return true;
  if (process.env.NEXT_PUBLIC_VERBOSE_IMAGES === 'false') return false;

  // Default: disable in all environments for clean console (enable on demand)
  return false;
})();

// Image logger interface
interface ImageLogger {
  log: (...args: any[]) => void;
  info: (...args: any[]) => void;
  warn: (...args: any[]) => void;
  error: (...args: any[]) => void;
  group: (label: string) => void;
  groupEnd: () => void;
  time: (label: string) => void;
  timeEnd: (label: string) => void;
  debug: (...args: any[]) => void;
  isEnabled: () => boolean;
}

/**
 * @deprecated To be deleted as we already have a Logger class in b4m-core
 */
export const imageLogger: ImageLogger = {
  log: (...args: any[]) => {
    if (isVerboseImages) {
      console.log(...args);
    }
  },
  info: (...args: any[]) => {
    if (isVerboseImages) {
      console.info(...args);
    }
  },
  warn: (...args: any[]) => {
    if (isVerboseImages) {
      console.warn(...args);
    }
  },
  error: (...args: any[]) => {
    // Always show errors, even in production
    console.error(...args);
  },
  group: (label: string) => {
    if (isVerboseImages) {
      console.group(label);
    }
  },
  groupEnd: () => {
    if (isVerboseImages) {
      console.groupEnd();
    }
  },
  time: (label: string) => {
    if (isVerboseImages) {
      console.time(label);
    }
  },
  timeEnd: (label: string) => {
    if (isVerboseImages) {
      console.timeEnd(label);
    }
  },
  debug: (...args: any[]) => {
    if (isVerboseImages) {
      console.log('[DEBUG]', ...args);
    }
  },
  isEnabled: () => isVerboseImages,
};

export default imageLogger;
