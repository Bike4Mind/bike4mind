/**
 * Admin audit actions that suspend or reinstate an account, shared by the verdict eval
 * (verdictEval/loadVerdictEval.ts) and the stale-detection grader (shadowDetectionAutoGrade.ts), so
 * both read the same account history.
 */
export const SUSPEND_ACTIONS = ['user.suspended', 'user.bulk.suspended', 'user.bulk.contained', 'abuse.bulk.ban'];
export const REINSTATE_ACTIONS = ['user.reinstated'];
export const REINSTATED_ENTRIES = [...REINSTATE_ACTIONS, 'user.bulk.undone'];
// A bulk undo only reinstates when it reverted a suspend or contain; undoing a tag or credit change says nothing.
const BULK_UNDONE_BAN = { action: 'user.bulk.undone', 'details.undoneAction': { $in: ['suspend', 'contain'] } };
export const ACCOUNT_STATUS_ACTIONS_FILTER = {
  $or: [{ action: { $in: [...SUSPEND_ACTIONS, ...REINSTATE_ACTIONS] } }, BULK_UNDONE_BAN],
};
