/**
 * Image generation logging utility. Toggles image generation debug logs.
 * Follows the same pattern as performanceLogger.ts
 */

// Environment-based configuration with flexible defaults
const isVerboseImages = (() => {
  // Check explicit setting first (takes priority)
  if (process.env.NEXT_PUBLIC_VERBOSE_IMAGES === 'true') return true;
  if (process.env.NEXT_PUBLIC_VERBOSE_IMAGES === 'false') return false;

  // Default: disable in all environments for clean console (enable on demand)
  return false;
})();

// Runtime configuration (can be changed dynamically)
let runtimeVerboseImages = isVerboseImages;

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
    if (runtimeVerboseImages) {
      console.log(...args);
    }
  },
  info: (...args: any[]) => {
    if (runtimeVerboseImages) {
      console.info(...args);
    }
  },
  warn: (...args: any[]) => {
    if (runtimeVerboseImages) {
      console.warn(...args);
    }
  },
  error: (...args: any[]) => {
    // Always show errors, even in production
    console.error(...args);
  },
  group: (label: string) => {
    if (runtimeVerboseImages) {
      console.group(label);
    }
  },
  groupEnd: () => {
    if (runtimeVerboseImages) {
      console.groupEnd();
    }
  },
  time: (label: string) => {
    if (runtimeVerboseImages) {
      console.time(label);
    }
  },
  timeEnd: (label: string) => {
    if (runtimeVerboseImages) {
      console.timeEnd(label);
    }
  },
  debug: (...args: any[]) => {
    if (runtimeVerboseImages) {
      console.log('[DEBUG]', ...args);
    }
  },
  isEnabled: () => runtimeVerboseImages,
};

// Utility functions
export const isImageLoggingEnabled = () => runtimeVerboseImages;

export const enableImageLogging = () => {
  runtimeVerboseImages = true;
  imageLogger.info('🎨 Image generation logging enabled');
};

export const disableImageLogging = () => {
  runtimeVerboseImages = false;
  console.log('🔇 Image generation logging disabled');
};

export const toggleImageLogging = () => {
  if (runtimeVerboseImages) {
    disableImageLogging();
  } else {
    enableImageLogging();
  }
  return runtimeVerboseImages;
};

// Global window function for runtime control (development only)
if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  (window as any).enableImageLogs = enableImageLogging;
  (window as any).disableImageLogs = disableImageLogging;
  (window as any).toggleImageLogs = toggleImageLogging;
  (window as any).isImageLogsEnabled = isImageLoggingEnabled;
}

export default imageLogger;
