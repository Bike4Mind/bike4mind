import { DLQ_QUEUE_PARAM } from '@bike4mind/common';

// The queue filter reuses the param the DLQ alarm's per-queue link carries (adminDlqReplayPath), so
// that link lands on its queue's messages. There is no free-text search on this page, so query and
// view are never written to the URL.
export const DLQ_SEARCH_KEYS = {
  query: 'dlqQuery',
  view: 'dlqView',
  filters: { feature: 'dlqFeature', queue: DLQ_QUEUE_PARAM },
} as const;
export const DLQ_TAB_PARAMS = Object.values(DLQ_SEARCH_KEYS.filters);
