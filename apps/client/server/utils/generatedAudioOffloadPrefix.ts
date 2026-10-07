/**
 * Key prefix for oversized generated audio staged for download (generatedAudioDelivery.ts).
 * Must stay in sync with the lifecycle rules in infra/buckets.ts
 * (`expire-generated-audio-offload`) and compose.selfhost.yaml, the only things that delete
 * these objects. Skipped by the object-created handlers via untrackedFabFileKey.ts (no
 * FabFile row). A leaf module so that key predicate stays free of storage imports.
 */
export { GENERATED_AUDIO_OFFLOAD_PREFIX } from '@bike4mind/common';
