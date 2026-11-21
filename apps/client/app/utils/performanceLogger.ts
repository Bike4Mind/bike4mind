/**
 * Performance logging utility. Toggles performance-related console logs.
 */

const isVerbosePerformance = (() => {
  // Check explicit setting first (takes priority)
  if (process.env.NEXT_PUBLIC_VERBOSE_PERFORMANCE === 'true') return true;
  if (process.env.NEXT_PUBLIC_VERBOSE_PERFORMANCE === 'false') return false;

  // Default: enable in development for debugging, disable in production
  return process.env.NODE_ENV === 'development';
})();

// Runtime configuration (can be changed dynamically)
let runtimeVerbosePerformance = isVerbosePerformance;

declare global {
  interface Window {
    enablePerfLogs?: () => void;
    disablePerfLogs?: () => void;
    togglePerfLogs?: () => boolean;
    isPerfLogsEnabled?: () => boolean;
  }
}

interface PerformanceLogger {
  log: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  group: (label: string) => void;
  groupEnd: () => void;
  time: (label: string) => void;
  timeEnd: (label: string) => void;
  trace: (...args: unknown[]) => void;
}

export const perfLogger: PerformanceLogger = {
  log: (...args: unknown[]) => {
    if (runtimeVerbosePerformance) {
      console.log(...args);
    }
  },
  info: (...args: unknown[]) => {
    if (runtimeVerbosePerformance) {
      console.info(...args);
    }
  },
  warn: (...args: unknown[]) => {
    if (runtimeVerbosePerformance) {
      console.warn(...args);
    }
  },
  error: (...args: unknown[]) => {
    // Always show errors, even in production
    console.error(...args);
  },
  group: (label: string) => {
    if (runtimeVerbosePerformance) {
      console.group(label);
    }
  },
  groupEnd: () => {
    if (runtimeVerbosePerformance) {
      console.groupEnd();
    }
  },
  time: (label: string) => {
    if (runtimeVerbosePerformance) {
      console.time(label);
    }
  },
  timeEnd: (label: string) => {
    if (runtimeVerbosePerformance) {
      console.timeEnd(label);
    }
  },
  trace: (...args: unknown[]) => {
    if (runtimeVerbosePerformance) {
      console.trace(...args);
    }
  },
};

export const isPerformanceLoggingEnabled = () => runtimeVerbosePerformance;

export const enablePerformanceLogging = () => {
  runtimeVerbosePerformance = true;
  perfLogger.info('🎯 Performance logging enabled');
};

export const disablePerformanceLogging = () => {
  runtimeVerbosePerformance = false;
  console.log('🔇 Performance logging disabled');
};

export const togglePerformanceLogging = () => {
  if (runtimeVerbosePerformance) {
    disablePerformanceLogging();
  } else {
    enablePerformanceLogging();
  }
  return runtimeVerbosePerformance;
};

// Global window function for runtime control (development only)
if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  window.enablePerfLogs = enablePerformanceLogging;
  window.disablePerfLogs = disablePerformanceLogging;
  window.togglePerfLogs = togglePerformanceLogging;
  window.isPerfLogsEnabled = isPerformanceLoggingEnabled;
}

export default perfLogger;
