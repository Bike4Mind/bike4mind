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

interface PerformanceLogger {
  log: (...args: any[]) => void;
  info: (...args: any[]) => void;
  warn: (...args: any[]) => void;
  error: (...args: any[]) => void;
  group: (label: string) => void;
  groupEnd: () => void;
  time: (label: string) => void;
  timeEnd: (label: string) => void;
  trace: (...args: any[]) => void;
}

export const perfLogger: PerformanceLogger = {
  log: (...args: any[]) => {
    if (runtimeVerbosePerformance) {
      console.log(...args);
    }
  },
  info: (...args: any[]) => {
    if (runtimeVerbosePerformance) {
      console.info(...args);
    }
  },
  warn: (...args: any[]) => {
    if (runtimeVerbosePerformance) {
      console.warn(...args);
    }
  },
  error: (...args: any[]) => {
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
  trace: (...args: any[]) => {
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
  (window as any).enablePerfLogs = enablePerformanceLogging;
  (window as any).disablePerfLogs = disablePerformanceLogging;
  (window as any).togglePerfLogs = togglePerformanceLogging;
  (window as any).isPerfLogsEnabled = isPerformanceLoggingEnabled;
}

export default perfLogger;
