/**
 * Suppress noisy Serwist service-worker console messages in development.
 */

let originalWarn: typeof console.warn;
let originalLog: typeof console.log;
let originalError: typeof console.error;
let isSuppressed = false;

export function suppressSerwistWarnings() {
  if (typeof window === 'undefined' || process.env.NODE_ENV !== 'development') {
    return;
  }

  if (!originalWarn) {
    originalWarn = console.warn;
    originalLog = console.log;
    originalError = console.error;
  }

  isSuppressed = true;

  console.warn = (...args: any[]) => {
    // waitUntil.js is a serwist internal - drop everything it emits.
    const stack = new Error().stack || '';
    if (stack.includes('waitUntil.js')) {
      return;
    }

    const message = args[0]?.toString() || '';

    if (
      message.includes('serwist') ||
      message.includes('Precaching did not find a match') ||
      message.includes('No route found for') ||
      message.includes('waitUntil') ||
      message.includes('service worker') ||
      message.includes('ServiceWorker')
    ) {
      return;
    }

    originalWarn.apply(console, args);
  };

  console.log = (...args: any[]) => {
    const stack = new Error().stack || '';
    if (stack.includes('waitUntil.js')) {
      return;
    }

    const message = args[0]?.toString() || '';

    if (
      message.includes('serwist') ||
      message.includes('Precaching') ||
      message.includes('No route found') ||
      message.includes('service worker') ||
      message.includes('ServiceWorker')
    ) {
      return;
    }

    originalLog.apply(console, args);
  };

  // Some libraries emit via console.error instead of console.warn.
  console.error = (...args: any[]) => {
    const stack = new Error().stack || '';
    if (stack.includes('waitUntil.js')) {
      return;
    }

    const message = args[0]?.toString() || '';

    if (
      message.includes('serwist') ||
      message.includes('Precaching') ||
      message.includes('No route found') ||
      message.includes('service worker') ||
      message.includes('ServiceWorker')
    ) {
      return;
    }

    originalError.apply(console, args);
  };
}

export function restoreConsole() {
  if (typeof window === 'undefined' || !originalWarn) return;

  isSuppressed = false;
  console.warn = originalWarn;
  console.log = originalLog;
  console.error = originalError;
}

export function toggleSerwistSuppression(): boolean {
  if (isSuppressed) {
    restoreConsole();
    return false;
  } else {
    suppressSerwistWarnings();
    return true;
  }
}

export function isSerwistSuppressed(): boolean {
  return isSuppressed;
}

export function getSerwistSuppressionPreference(): boolean {
  if (typeof window === 'undefined') return true; // Default to suppressed
  return localStorage.getItem('suppressSerwist') !== 'false';
}

export function setSerwistSuppressionPreference(suppress: boolean) {
  if (typeof window === 'undefined') return;
  localStorage.setItem('suppressSerwist', suppress.toString());
}
