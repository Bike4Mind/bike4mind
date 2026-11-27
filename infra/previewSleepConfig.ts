import { chatCompletionScaling, type ServiceScaling } from './chatCompletionCapacity';

// Weekend-only window; widening it to weekday nights is a team call, so these stay tunable here.
export const PREVIEW_SLEEP_CRON = 'cron(0 2 ? * SAT *)';
export const PREVIEW_WAKE_CRON = 'cron(0 23 ? * SUN *)';
export const PREVIEW_SLEEP_TIMEZONE = 'UTC';

export const PREVIEW_ASLEEP: ServiceScaling = { min: 0, max: 0 };

export type PreviewSleepLabel = 'chat-completion' | 'subscriber-fanout';

export interface PreviewSleepTarget {
  label: PreviewSleepLabel;
  awake: ServiceScaling;
}

/**
 * The preview ECS services that sleep, and the task bounds a wake restores. subscriber-fanout
 * sets no `scaling`, so its awake value is SST's Service default and must stay in sync with
 * infra/subscriberFanout.ts if that ever gains one.
 */
export const previewSleepTargets = (): PreviewSleepTarget[] => [
  { label: 'chat-completion', awake: chatCompletionScaling(false) },
  { label: 'subscriber-fanout', awake: { min: 1, max: 1 } },
];
