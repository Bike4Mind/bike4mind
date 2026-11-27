import type { Delegation } from '@bike4mind/common';
import type { IDelegatedItem } from '@bike4mind/database';

/** The wire shape (`DelegationSchema`). The owner, failure reason and model stay server-side. */
export function serializeDelegation(item: IDelegatedItem): Delegation {
  return {
    id: item._id.toString(),
    status: item.status,
    intent: item.intent,
    url: item.url,
    text: item.text,
    file_ids: item.fileIds,
    result: item.result,
    created_at: item.createdAt.toISOString(),
    settled_at: item.settledAt ? item.settledAt.toISOString() : null,
  };
}
