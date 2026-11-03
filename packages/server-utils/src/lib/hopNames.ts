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

/**
 * The HttpOnly first-party cookie that holds a redeemed hop's id for the signup it may lead to.
 * Set only with the visitor's consent. Server-only: no client code reads it.
 */
export const HOP_COOKIE = 'b4m_hop';
