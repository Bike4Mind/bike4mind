import { SchemaDefinitionProperty } from 'mongoose';

/**
 * Shared deep-agent persistence primitives.
 *
 * These shapes are mirrored inline from the Zod source of truth in
 * `@bike4mind/agents/src/deepAgent/schemas/` (drives.ts, evidence.ts). The
 * database package deliberately does NOT depend on `@bike4mind/agents` - the
 * same convention used by `IDagNodeSpec` in AgentExecutionModel. Keep these in
 * sync with the Zod schemas; the Zod layer is authoritative.
 *
 * Defined once here (rather than per-model) so the models barrel does not
 * re-export `EvidenceTier` / `IDriveVector` from two files and collide.
 */

// ── Evidence tiers (mirror of evidence.ts) ─────────────────────────
export type EvidenceTier = 'engineering-proxy' | 'engineering-scaled' | 'external-facing' | 'human-reviewed';

/** Ordered low->high; matches EVIDENCE_TIER_ORDER in the Zod layer. */
export const EVIDENCE_TIERS: EvidenceTier[] = [
  'engineering-proxy',
  'engineering-scaled',
  'external-facing',
  'human-reviewed',
];

// ── Drive vector (mirror of drives.ts) ─────────────────────────────
export interface IDriveVector {
  curiosity: number;
  progress: number;
  social: number;
  novelty: number;
  caution: number;
  aesthetic: number;
}

export const DRIVE_KEYS: (keyof IDriveVector)[] = [
  'curiosity',
  'progress',
  'social',
  'novelty',
  'caution',
  'aesthetic',
];

/** A single bounded [0,1] scalar field used for every drive. */
const driveField: SchemaDefinitionProperty<number> = {
  type: Number,
  required: true,
  min: 0,
  max: 1,
};

/**
 * Mongoose schema-definition fragment for an embedded drive vector. Use as
 * `drives: { type: driveVectorSchemaDef, _id: false, required: true }` or
 * embed the object directly as a nested path.
 */
export const driveVectorSchemaDef = {
  curiosity: driveField,
  progress: driveField,
  social: driveField,
  novelty: driveField,
  caution: driveField,
  aesthetic: driveField,
} as const;
