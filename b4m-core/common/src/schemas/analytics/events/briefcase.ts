import { IBaseEvent } from '../../../types/analytics';

/**
 * Briefcase observability signals. PII rule: NEVER log prompt content, resolved
 * context values, or entity/org names - personal prompts carry sensitive data
 * and logs are long-lived. Metadata below is a CLOSED shape (no
 * Record<string, unknown>) so content can't be appended at a call site without
 * a type error. Log only ids, the prompt's ownership class, and signal kinds.
 */
export enum BriefcaseEvents {
  /** A launcher was clicked. */
  PROMPT_SELECTED = 'Briefcase Prompt Selected',
  /** Personal prompts were read (audit trail for the personal-scoping contract). */
  PERSONAL_READ = 'Briefcase Personal Read',
  /** Template substitution left placeholders unresolved (silent quality decay). */
  RESOLUTION_FAILED = 'Briefcase Resolution Failed',
  /** The reference-data guard sanitized an interpolated value (injection-probe canary). */
  GUARD_TRIGGERED = 'Briefcase Guard Triggered',
}

interface IBriefcasePromptSelectedEvent extends IBaseEvent {
  type: BriefcaseEvents.PROMPT_SELECTED;
  metadata: {
    promptId: string;
    /** Ownership class - NOT the prompt's category text. */
    ownership: 'system' | 'personal';
    executionMode: string;
  };
}

interface IBriefcasePersonalReadEvent extends IBaseEvent {
  type: BriefcaseEvents.PERSONAL_READ;
  metadata: {
    /** The authenticated caller (== owner; personal reads are caller-scoped). */
    ownerId: string;
    resultCount: number;
  };
}

interface IBriefcaseResolutionFailedEvent extends IBaseEvent {
  type: BriefcaseEvents.RESOLUTION_FAILED;
  metadata: {
    promptId: string;
    unresolvedPlaceholderCount: number;
  };
}

interface IBriefcaseGuardTriggeredEvent extends IBaseEvent {
  type: BriefcaseEvents.GUARD_TRIGGERED;
  metadata: {
    promptId: string;
    /** The KIND of sanitization only - never the offending value. */
    kind: 'stripped' | 'capped' | 'rejected';
  };
}

export type BriefcaseEventPayload =
  | IBriefcasePromptSelectedEvent
  | IBriefcasePersonalReadEvent
  | IBriefcaseResolutionFailedEvent
  | IBriefcaseGuardTriggeredEvent;
