/**
 * Client-safe product-surface name literals.
 *
 * The `session.surface` field (SessionTypes) scopes a session to a product
 * surface. These are the canonical values for OPEN surfaces whose names are not
 * guarded IP - currently just Opti (`/opti`, the datalake survivor). Both
 * client and server import from here, so the surface contract has one home with
 * zero bundle penalty (`@bike4mind/common` is already client-safe).
 *
 * NOTE: guarded product-surface tokens (the oncology module's surface, etc.)
 * deliberately do NOT live here. Their identity home stays inside the module's
 * owned namespace per the extraction boundary - shared core must never own a
 * guarded token, nor import from an owned namespace. The literal must not even
 * appear in this file (the boundary guard greps for it), which is why this note
 * names no token. See scripts/check-libonc-boundary.sh and the module's
 * EXTRACTION.md §4.
 */

/** Product-surface tag stamped on Opti / OptiHashi (`/opti`) sessions. */
export const OPTI_SURFACE = 'opti';
