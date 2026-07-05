import { IVariantDescriptor } from '@bike4mind/common';

/**
 * Exhaustive registry of all valid audience keys for lumina5 modals.
 *
 * This is the single source of truth - the `ModalAudienceKey` union and Zod
 * enum are derived from it so they can never drift. Adding a new key here
 * immediately makes it a compile-time requirement everywhere the union is used.
 *
 * `as const satisfies` preserves literal types on `key` so the derived union
 * is 'internal' | 'customer' rather than the widened `string`.
 */
export const AUDIENCE_VARIANTS = [
  { key: 'internal', audienceType: 'internal', label: 'Internal' },
  { key: 'customer', audienceType: 'customer', label: 'Customer' },
] as const satisfies readonly IVariantDescriptor[];

/** Derived literal union - compile error if the registry is extended but the consuming code isn't. */
export type ModalAudienceKey = (typeof AUDIENCE_VARIANTS)[number]['key'];

/** Set of valid keys for fast membership checks. */
export const MODAL_AUDIENCE_KEY_SET = new Set<string>(AUDIENCE_VARIANTS.map(v => v.key));

/** The safe-default key: least-privileged audience shown on classifier error. */
export const MODAL_SAFE_DEFAULT_KEY: ModalAudienceKey = 'customer';
