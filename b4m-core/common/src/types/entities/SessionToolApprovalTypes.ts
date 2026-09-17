import { IBaseRepository } from './BaseTypes';

/**
 * A user's remembered agent-mode tool decisions for one session (notebook).
 *
 * Scoped by user AND session because a session can be shared: one collaborator's
 * "Allow for Session" must not silently approve a side-effecting tool on behalf of
 * everyone else in the notebook.
 */
export interface ISessionToolApproval {
  id: string;
  userId: string;
  sessionId: string;
  /** Tool names the user chose to keep approved. */
  approvedTools: string[];
  /** Tool names the user chose to keep denied. Wins over `approvedTools` at the gate. */
  deniedTools: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface ISessionToolApprovalDocument extends ISessionToolApproval {}

export interface ISessionToolApprovalRepository extends IBaseRepository<ISessionToolApprovalDocument> {
  /** The user's remembered decisions for one session, or null when they have made none. */
  findByUserAndSession: (userId: string, sessionId: string) => Promise<ISessionToolApprovalDocument | null>;

  /**
   * Remember one decision. `decision: 'approved'` moves the tool onto `approvedTools` and
   * off `deniedTools`; `'denied'` does the reverse - a tool is never on both lists, so a
   * later decision always supersedes an earlier one rather than being shadowed by it.
   */
  rememberDecision: (
    userId: string,
    sessionId: string,
    toolName: string,
    decision: 'approved' | 'denied'
  ) => Promise<ISessionToolApprovalDocument>;

  /** Drop one remembered decision (the revoke path). */
  forgetTool: (userId: string, sessionId: string, toolName: string) => Promise<ISessionToolApprovalDocument | null>;

  /** Drop every remembered decision for one user in one session. */
  forgetAll: (userId: string, sessionId: string) => Promise<void>;
}
