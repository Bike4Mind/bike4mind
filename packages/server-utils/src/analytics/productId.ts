import { z } from 'zod';

/**
 * The one rule for an Overwatch product id in this app: the hop mint route
 * (pages/api/overwatch/v1/hops.ts) refuses a key bound to anything else, and emitProductEvent keeps
 * a product-id metadata field (`src`, `dest`, `srcProductId`) only when it matches. Sharing it is
 * what keeps a hop that can be minted from losing its `src` when it is redeemed.
 *
 * Mirrors the product registry's rule in Overwatch (letters of either case, digits, `-` and `_`, at
 * most 64), since that is where ingest keys and their product ids come from. Keep the two in sync:
 * a stricter rule here drops real products' fields, and a looser one lets through ids Overwatch
 * cannot hold.
 */
export const PRODUCT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export const productIdSchema = z.string().regex(PRODUCT_ID_PATTERN);
