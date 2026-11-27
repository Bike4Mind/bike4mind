/** UUID v4. `crypto.randomUUID` exists only in secure contexts; plain-http LAN self-host has only `getRandomValues`. */
export function randomUuid(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  if (typeof c?.getRandomValues !== 'function')
    throw new Error('randomUuid: Web Crypto is unavailable in this runtime');
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
