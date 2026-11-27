// Verified-hop names shared by the browser (app/utils/visitBeacon.ts takes the token off the landing
// URL), the proxy (proxy.ts tightens Referrer-Policy on a landing that carries one) and the server
// (server/analytics/hops.ts redeems the token and sets the cookie). Kept here so no layer imports
// another's module.

/**
 * The query parameter a source product's redirect carries the hop token in. The source's server
 * mints the token and redirects straight to `<app>/<path>?b4m_hop=<token>`; the token is never
 * rendered into a page.
 */
export const HOP_PARAM = 'b4m_hop';

/** The longest hop token the browser sends on and the server accepts. A real one is 87 characters. */
export const MAX_HOP_TOKEN_LENGTH = 128;

/**
 * The HttpOnly first-party cookie that holds a redeemed hop's id for the signup it may lead to.
 * Set only with the visitor's consent. Server-only: no client code reads it.
 */
export const HOP_COOKIE = 'b4m_hop';

/**
 * The Overwatch events a hop produces. Only this deployment's own paths may send them: the mint
 * route queues `hop_minted` directly, and the redeem sends `hop` under the host product's key.
 * The ingest route refuses both from anyone else (pages/api/overwatch/v1/events.ts), since a
 * product that could post them itself could claim hops nobody minted or redeemed.
 */
export const HOP_MINTED_EVENT = 'hop_minted';
export const HOP_EVENT = 'hop';
