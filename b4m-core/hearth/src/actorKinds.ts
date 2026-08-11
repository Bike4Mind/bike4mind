import type { ActorKind } from './types';

/**
 * The label every surface shows for an actor kind, so the SPA badge and the CLI
 * marker cannot drift apart.
 *
 * This is the visible half of the actor-spoofing mitigation, not decoration.
 * `human` is reserved server-side (see HearthActorParamSchema in the client's
 * hearthWire): a self-identifying caller may only claim agent, gateway, or
 * device, and the human actor is derived from the authenticated session. So a
 * rendered "Human" badge always means session-derived, and an agent that names
 * itself "erik" still renders as an Agent. Surfaces must render the badge
 * unconditionally - suppressing it for the common kind is what would let a
 * forged name pass unremarked.
 */
export const ACTOR_KIND_LABELS: Record<ActorKind, string> = {
  human: 'Human',
  agent: 'Agent',
  gateway: 'Gateway',
  device: 'Device',
  system: 'System',
};

/** Single-character marker for text-only surfaces (the CLI /hearth listing). */
export const ACTOR_KIND_MARKERS: Record<ActorKind, string> = {
  human: 'H',
  agent: 'A',
  gateway: 'G',
  device: 'D',
  system: 'S',
};

export function actorKindLabel(kind: ActorKind | undefined): string {
  return kind ? ACTOR_KIND_LABELS[kind] : 'Unknown';
}

export function actorKindMarker(kind: ActorKind | undefined): string {
  return kind ? ACTOR_KIND_MARKERS[kind] : '?';
}
