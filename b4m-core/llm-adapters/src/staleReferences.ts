import type { CatalogLifecycle } from './deprecationHorizon';
import { DEPRECATED_MODEL_MAP, replacedByOverlayEntries } from './resolveDeprecatedModel';

/**
 * The nightly fallback-chain hygiene check (sec 5.10): every hardcoded id that
 * names a model which is deprecated, retired, or gone entirely. Report only -
 * these surfaces are code and an operator edits them, so nothing here rewrites
 * anything.
 */

export type StaleReferenceProblem = 'deprecated' | 'retired' | 'unknown';

/**
 * Which hardcoded table the reference lives in. Chain keys are reported apart
 * from chain entries on purpose: a chain FOR a dead model is dead weight, while
 * a chain pointing AT one is the outage this check exists to prevent.
 */
export type StaleReferenceSurface =
  'fallback-chain' | 'fallback-chain-key' | 'fallback-default' | 'deprecated-model-map' | 'replaced-by-overlay';

export interface StaleModelReference {
  surface: StaleReferenceSurface;
  /** Which entry of the surface: the chain's key model, or the redirect's source id. */
  key: string;
  referencedId: string;
  problem: StaleReferenceProblem;
}

/** The one model fact this check needs; ModelInfo satisfies it structurally. */
export interface StaleReferenceModel {
  id: string;
  deprecationDate?: string;
}

export interface StaleReferenceInput {
  /**
   * The UNFILTERED model view. The picker's deprecation filter must not have run
   * first: a filtered list turns every dead reference into 'unknown' and loses
   * the distinction the report is for.
   */
  models: readonly StaleReferenceModel[];
  /**
   * Catalog lifecycle per model id. Supplies the retired/deprecated distinction
   * ModelInfo cannot express (it carries only deprecationDate) and keeps models
   * the picker already dropped classifiable.
   */
  lifecycles?: ReadonlyMap<string, CatalogLifecycle>;
  /**
   * `FALLBACK_PREFERENCES` from @bike4mind/utils, injected rather than imported:
   * utils depends on this package, so the dependency cannot point the other way.
   */
  fallbackChains?: Readonly<Record<string, readonly string[]>>;
  /** The generic chain findAutomaticFallback uses when a model has no entry. */
  defaultChain?: readonly string[];
  now?: Date;
}

const isPast = (calendarDate: string | undefined, now: Date): boolean => {
  if (!calendarDate) return false;
  // Inclusive, matching the picker filter: a model whose date is today is gone.
  return now.getTime() >= new Date(calendarDate + 'T00:00:00Z').getTime();
};

/** One id's verdict, with the per-call lookup built once for a whole scan. */
function referenceClassifier(input: StaleReferenceInput): (referencedId: string) => StaleReferenceProblem | null {
  const now = input.now ?? new Date();
  const byId = new Map(input.models.map(model => [String(model.id), model]));

  return referencedId => {
    const model = byId.get(referencedId);
    const lifecycle = input.lifecycles?.get(referencedId);
    if (!model && !lifecycle) return 'unknown';

    if (lifecycle?.status === 'retired' || isPast(lifecycle?.retirementDate, now)) return 'retired';
    if (
      lifecycle?.status === 'deprecated' ||
      isPast(lifecycle?.deprecationDate, now) ||
      isPast(model?.deprecationDate, now)
    ) {
      return 'deprecated';
    }
    return null;
  };
}

/**
 * Is this one id safe to point new traffic at? Same verdict the report uses, so
 * a successor an operator accepts cannot be something the report then flags.
 * `fallbackChains` / `defaultChain` are ignored here.
 */
export function classifyModelReference(referencedId: string, input: StaleReferenceInput): StaleReferenceProblem | null {
  return referenceClassifier(input)(referencedId);
}

export function checkStaleModelReferences(input: StaleReferenceInput): StaleModelReference[] {
  const found: StaleModelReference[] = [];
  const classify = referenceClassifier(input);

  const check = (surface: StaleReferenceSurface, key: string, referencedId: string) => {
    const problem = classify(referencedId);
    if (problem) found.push({ surface, key, referencedId, problem });
  };

  for (const [chainKey, chain] of Object.entries(input.fallbackChains ?? {})) {
    check('fallback-chain-key', chainKey, chainKey);
    for (const referencedId of chain) check('fallback-chain', chainKey, referencedId);
  }

  for (const referencedId of input.defaultChain ?? []) check('fallback-default', 'default', referencedId);

  // Only the targets: the keys of a redirect table are dead ids by definition.
  for (const [source, target] of Object.entries(DEPRECATED_MODEL_MAP)) check('deprecated-model-map', source, target);
  for (const [source, target] of replacedByOverlayEntries()) check('replaced-by-overlay', source, target);

  // Stable order so a diff between two runs shows only real movement.
  return found.sort(
    (a, b) =>
      a.surface.localeCompare(b.surface) || a.key.localeCompare(b.key) || a.referencedId.localeCompare(b.referencedId)
  );
}
