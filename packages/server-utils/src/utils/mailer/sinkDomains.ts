/**
 * Recipient domains the email-send worker drops instead of delivering. Set per stage through
 * MAIL_SINK_DOMAINS (comma separated); the infra side fills it on every stage but production so
 * synthetic signup and invite mail never reaches the SES bounce path. Full-domain match only.
 */
export function parseMailSinkDomains(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map(entry => entry.trim().toLowerCase())
    .filter(entry => entry.length > 0);
}

export function findMailSinkDomain(address: string, sinkDomains: readonly string[]): string | undefined {
  if (sinkDomains.length === 0) return undefined;
  const trimmed = address.trim();
  const at = trimmed.lastIndexOf('@');
  if (at < 0 || at === trimmed.length - 1) return undefined;
  const domain = trimmed.slice(at + 1).toLowerCase();
  return sinkDomains.find(sink => sink === domain);
}
