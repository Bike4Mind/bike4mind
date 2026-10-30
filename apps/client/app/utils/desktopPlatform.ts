export type DesktopOs = 'mac' | 'linux' | 'windows' | 'other';
export type DesktopArch = 'arm64' | 'x64' | 'unknown';

export interface DetectedPlatform {
  os: DesktopOs;
  arch: DesktopArch;
}

interface UserAgentDataLike {
  platform?: string;
  getHighEntropyValues?: (hints: string[]) => Promise<{ architecture?: string; bitness?: string }>;
}

export interface NavigatorLike {
  userAgent: string;
  maxTouchPoints?: number;
  userAgentData?: UserAgentDataLike;
}

/**
 * Best guess from the user-agent string alone. Every browser on an Apple Silicon Mac still
 * reports "Intel Mac OS X", so a Mac's architecture is never known from here.
 */
export function detectPlatformFromUserAgent(userAgent: string, maxTouchPoints = 0): DetectedPlatform {
  const ua = userAgent.toLowerCase();
  if (/iphone|ipad|ipod|android|cros/.test(ua)) return { os: 'other', arch: 'unknown' };
  // iPadOS asks for desktop sites with a Mac user agent; a touch screen gives it away.
  if (ua.includes('macintosh') || ua.includes('mac os x')) {
    return maxTouchPoints > 1 ? { os: 'other', arch: 'unknown' } : { os: 'mac', arch: 'unknown' };
  }
  if (ua.includes('windows')) return { os: 'windows', arch: 'unknown' };
  if (ua.includes('linux')) {
    if (/aarch64|arm64|armv\d/.test(ua)) return { os: 'linux', arch: 'arm64' };
    if (/x86_64|amd64|x64/.test(ua)) return { os: 'linux', arch: 'x64' };
    return { os: 'linux', arch: 'unknown' };
  }
  return { os: 'other', arch: 'unknown' };
}

function osFromClientHint(platform: string | undefined): DesktopOs | undefined {
  switch (platform?.toLowerCase()) {
    case 'macos':
      return 'mac';
    case 'linux':
      return 'linux';
    case 'windows':
      return 'windows';
    case undefined:
    case '':
      return undefined;
    default:
      return 'other';
  }
}

/**
 * Refines the user-agent guess with User-Agent Client Hints where the browser has them
 * (Chromium only). The architecture hint is the one way a page can tell an Apple Silicon Mac
 * from an Intel one; anywhere it is missing or refused, the architecture stays `unknown`.
 */
export async function detectPlatform(nav: NavigatorLike): Promise<DetectedPlatform> {
  const fromUa = detectPlatformFromUserAgent(nav.userAgent, nav.maxTouchPoints);
  const hints = nav.userAgentData;
  if (!hints) return fromUa;

  const os = osFromClientHint(hints.platform) ?? fromUa.os;
  if (os === 'other') return { os, arch: 'unknown' };
  let arch: DesktopArch = os === fromUa.os ? fromUa.arch : 'unknown';
  try {
    const values = await hints.getHighEntropyValues?.(['architecture', 'bitness']);
    if (values?.architecture === 'arm' && values.bitness !== '32') arch = 'arm64';
    else if (values?.architecture === 'x86' && values.bitness !== '32') arch = 'x64';
  } catch {
    // Some browsers reject high-entropy hints; keep what the user agent said.
  }
  return { os, arch };
}
