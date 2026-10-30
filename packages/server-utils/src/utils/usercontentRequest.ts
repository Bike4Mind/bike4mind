// Kept dependency-free: infra serializes this function into the CDN viewer-request gate.
export function allowsUsercontentRequest(host: string, pathname: string, method: string, domain: string): boolean {
  if (!domain) return true;
  const hostname = host.toLowerCase().split(':')[0].replace(/\.$/, '');
  const suffix = `.usercontent.app.${domain.toLowerCase()}`;
  if (hostname !== suffix.slice(1) && !hostname.endsWith(suffix)) return true;
  const publicId = hostname.slice(0, -suffix.length);
  return /^[a-z0-9-]+$/.test(publicId) && pathname.startsWith('/uc/') && (method === 'GET' || method === 'HEAD');
}
