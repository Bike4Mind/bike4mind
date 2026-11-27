import { IMongoDocument } from './common';
import { MCP_TOOL_APPROVAL_MODES } from './McpConnectionTypes';

/** When a recipient is asked before a call in chat: the same modes as an MCP tool. */
export const CALLABLE_FUNCTION_APPROVAL_MODES = MCP_TOOL_APPROVAL_MODES;
export type CallableFunctionApprovalMode = (typeof CALLABLE_FUNCTION_APPROVAL_MODES)[number];

/**
 * One recipient's review of a function shared with them, in `callablefunctionreviews`, one row per function and
 * person. It holds while `reviewHash` matches the live pin's interface (name, description, and schemas, never the
 * code), so a new pin with the same interface keeps it and a changed one reads as pending again.
 */
export interface ICallableFunctionReview {
  functionId: string;
  userId: string;
  reviewHash: string;
  approval: CallableFunctionApprovalMode;
  /** False when the recipient turned the function off; it is not callable until they turn it on. */
  enabled: boolean;
  reviewedAt: Date;
  /** The interface `reviewHash` names, so a later change can be listed field by field; absent on older reviews. */
  reviewed?: CallableFunctionReviewedInterface;
}

export interface CallableFunctionReviewedInterface {
  name: string;
  description: string;
  inputs: unknown;
  outputs: unknown;
}

export interface ICallableFunctionReviewDocument extends ICallableFunctionReview, IMongoDocument {}

/** What the recipient reads of their own review. */
export interface ICallableFunctionReviewView {
  approval: CallableFunctionApprovalMode;
  enabled: boolean;
  reviewedAt: Date;
  /** The review matches the live pin's interface. */
  current: boolean;
}
