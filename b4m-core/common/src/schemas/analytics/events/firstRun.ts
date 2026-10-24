import { IBaseEvent } from '../../../types';

export enum FirstRunEvents {
  WELCOME_CARD_SHOWN = 'welcome_card_shown',
  WELCOME_CARD_CLICKED = 'welcome_card_clicked',
  WELCOME_CARD_DISMISSED = 'welcome_card_dismissed',
  STARTER_USED = 'starter_used',
  POLICIES_SHOWN = 'policies_shown',
  POLICIES_ACCEPTED = 'policies_accepted',
  START_HERE_CHIP_SHOWN = 'start_here_chip_shown',
  START_HERE_CHIP_CLICKED = 'start_here_chip_clicked',
  GEARS_PAGE_OPENED = 'gears_page_opened',
  CREDITS_CHIP_CLICKED = 'credits_chip_clicked',
  BILLING_OPENED = 'billing_opened',
  BILLING_CLOSED_WITHOUT_PURCHASE = 'billing_closed_without_purchase',
  ZERO_STATE_SHOWN = 'zero_state_shown',
  SEND_BLOCKED = 'send_blocked',
  FILE_READY_MS = 'file_ready_ms',
  FIRST_ANSWER_CREDITS = 'first_answer_credits',
}

export interface FirstRunEventPayload extends IBaseEvent {
  type: FirstRunEvents;
  metadata?: Record<string, string | number | boolean>;
}
