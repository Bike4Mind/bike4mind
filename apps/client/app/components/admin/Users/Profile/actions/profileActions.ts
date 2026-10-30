import type { AdminUserProfile } from '../userProfileModel';

/** Every named write on the profile. Each opens one dialog; the page renders only the active one. */
export type ProfileAction =
  | 'editProfile'
  | 'credits'
  | 'suspend'
  | 'reinstate'
  | 'restrict'
  | 'shadowTier'
  | 'role'
  | 'productAccess'
  | 'tags'
  | 'mfaReset'
  | 'emailVerification'
  | 'apiKeyTrust'
  | 'subscription'
  | 'loginAs'
  | 'message'
  | 'delete';

/**
 * Props of every profile action dialog. A dialog is mounted only while open, so its own inputs start
 * fresh each time. `onAudit` opens the Admin log, for the UndoToast's audit link.
 */
export type ProfileDialogProps = {
  user: AdminUserProfile;
  onClose: () => void;
  onAudit?: () => void;
};
