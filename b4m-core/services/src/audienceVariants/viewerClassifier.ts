import { IViewerContext, IViewerClassifier } from '@bike4mind/common';
import { ModalAudienceKey, MODAL_SAFE_DEFAULT_KEY } from './variantRegistry';

/**
 * Extended viewer context for lumina5's admin-based classifier.
 *
 * Audience is determined by `user.isAdmin` - admin users are internal team
 * members who should see all change types; non-admins receive the scrubbed
 * customer-facing slice. The flag is already loaded by the auth middleware
 * and requires no additional DB lookup.
 */
export interface ILuminaViewerContext extends IViewerContext {
  /** Whether the viewer is an admin (req.user.isAdmin). */
  isAdmin: boolean;
}

/**
 * Server-side viewer classifier for lumina5 modal audience variants.
 *
 * Maps viewer identity to an audience key using `user.isAdmin`:
 * - 'internal'  -> admin users (internal team members)
 * - 'customer'  -> everyone else (safe default)
 *
 * `classify` is synchronous - the flag is already loaded by the auth middleware
 * and requires no additional DB lookup. The serving handler still wraps it in
 * a try/catch and substitutes `safeDefaultKey` per the blueprint contract.
 */
export const viewerClassifier: IViewerClassifier<ModalAudienceKey> = {
  safeDefaultKey: MODAL_SAFE_DEFAULT_KEY,

  classify(context: IViewerContext): ModalAudienceKey {
    if (!context) return MODAL_SAFE_DEFAULT_KEY;
    const { isAdmin } = context as ILuminaViewerContext;
    return isAdmin === true ? 'internal' : 'customer';
  },
};
