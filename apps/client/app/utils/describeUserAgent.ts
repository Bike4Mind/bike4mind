/**
 * Best-effort, dependency-free description of a device from its User-Agent string, for the
 * Active Sessions list. AuthSession device metadata captures only the raw UA + IP
 * (server/auth/sessionDevice.ts), so this derives a friendly "Browser on OS" label without
 * pulling in a UA-parser dependency. Intentionally coarse: it only needs to help a user
 * recognize their own devices, not fingerprint them. Order matters - more specific tokens are
 * checked before the generic ones they embed (Edge/Chrome before Safari; iOS/Android before
 * their desktop hosts).
 */

export interface DeviceDescription {
  browser: string;
  os: string;
  /** "Browser on OS", or a graceful fallback when the UA is missing/unrecognized. */
  label: string;
}

function detectBrowser(ua: string): string {
  if (/\bEdg(e|A|iOS)?\//.test(ua)) return 'Edge';
  if (/\bOPR\/|\bOpera\b/.test(ua)) return 'Opera';
  // Chrome's UA contains "Safari"; check Chrome (and Chromium) first.
  if (/\bChrome\/|\bCriOS\//.test(ua)) return 'Chrome';
  if (/\bFirefox\/|\bFxiOS\//.test(ua)) return 'Firefox';
  if (/\bSafari\//.test(ua)) return 'Safari';
  return 'Unknown browser';
}

function detectOs(ua: string): string {
  if (/\biPhone\b/.test(ua)) return 'iPhone';
  if (/\biPad\b/.test(ua)) return 'iPad';
  if (/\bAndroid\b/.test(ua)) return 'Android';
  if (/\bWindows NT\b/.test(ua)) return 'Windows';
  // "Mac OS X" also appears on iOS UAs, so this stays below the iPhone/iPad checks.
  if (/\bMac OS X\b|\bMacintosh\b/.test(ua)) return 'macOS';
  if (/\bLinux\b/.test(ua)) return 'Linux';
  return 'Unknown OS';
}

export function describeUserAgent(userAgent: string | undefined | null): DeviceDescription {
  const ua = (userAgent ?? '').trim();
  if (!ua) {
    return { browser: 'Unknown browser', os: 'Unknown OS', label: 'Unknown device' };
  }
  const browser = detectBrowser(ua);
  const os = detectOs(ua);
  const knownBrowser = browser !== 'Unknown browser';
  const knownOs = os !== 'Unknown OS';

  if (knownBrowser && knownOs) return { browser, os, label: `${browser} on ${os}` };
  if (knownBrowser) return { browser, os, label: browser };
  if (knownOs) return { browser, os, label: os };
  return { browser, os, label: 'Unknown device' };
}
