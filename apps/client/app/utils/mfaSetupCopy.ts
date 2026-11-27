/**
 * Copy for forced MFA enrollment, shared by the sign-in step (useMfaChallenge) and the in-app
 * block (MFAEnforcementWrapper). enforceMFA is a deployment-wide setting, not an org policy, and
 * most users who meet it are self-serve, so the copy never points at "your administrator".
 */
export const MFA_SETUP_TITLE = 'Secure your account';

export const MFA_SETUP_REASON = 'To keep your account and your credits safe, every account adds a second sign-in step.';

export const MFA_SETUP_DESCRIPTION = `${MFA_SETUP_REASON} Scan the QR code with an authenticator app, then enter the 6-digit code it shows.`;

export const MFA_SETUP_SIGN_OUT_HINT = "You'll be asked to finish this step the next time you sign in.";

export const MFA_SETUP_SIGNED_OUT_TOAST =
  "You're signed out. You'll be asked to secure your account the next time you sign in.";
