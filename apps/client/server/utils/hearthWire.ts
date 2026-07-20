import type { HearthEvent } from '@bike4mind/hearth';
import type { IHearthEventAction } from '@bike4mind/common';

type WireHearthEvent = IHearthEventAction['event'];

/**
 * Domain HearthEvent -> wire shape shared by the /api/hearth responses and
 * the hearth_event WS action (Dates become ISO strings; actorName is resolved
 * server-side so surfaces need no actor lookup).
 */
export function toWireHearthEvent(event: HearthEvent, actorName?: string): WireHearthEvent {
  return {
    id: event.id,
    channelId: event.channelId,
    seq: event.seq,
    actorId: event.actorId,
    actorName,
    kind: event.kind,
    human: event.human,
    machine: event.machine,
    refs: event.refs,
    createdAt: event.createdAt.toISOString(),
  };
}
