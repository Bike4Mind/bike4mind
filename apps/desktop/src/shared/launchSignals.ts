/**
 * What this machine says about the user, read once on a first launch with nothing remembered so
 * the app can open on Code for people who code and Chat for everyone else. Local and cheap: a
 * couple of file checks, never a network call. See main/chat/launchSignals.ts and
 * renderer/src/chat/rail/launchPlace.ts.
 */
export interface LaunchSignals {
  /** Claude Code has been set up here (its config or credentials file exists in the home folder). */
  claudeCode: boolean;
  /** A folder this app grounded a Code session in is a git repository. */
  recentRepository: boolean;
}

export const NO_LAUNCH_SIGNALS: LaunchSignals = { claudeCode: false, recentRepository: false };
