import { IVariantDescriptor, VariantContent } from '@bike4mind/common';

/**
 * Generation-time prompt scoping + write-side leak defense for audience variants.
 *
 * This is the generation-time counterpart to the serve-time leak guard
 * (`extractVariantForViewer`). The guard stops the wrong *slice* reaching a
 * viewer; it cannot inspect a slice's *fields*. So generation must (1) bias the
 * model toward audience-appropriate content per variant, and (2) scrub internal
 * material out of less-privileged variants - a content-level leak the guard
 * can never catch.
 *
 * Only per-variant *scoping* lives here. The generation machinery (scheduling,
 * source collection, model config, persistence) is the worker's concern.
 */

/**
 * Sentinel a generation call returns when nothing qualifies for the variant.
 * Reuses the worker's pre-existing empty-result token so the existing parse
 * path recognizes it. Mapped to "omit this variant" by the caller, which the
 * serve-time guard then treats as "no content for this viewer -> drop".
 */
export const NO_VARIANT_CONTENT_SENTINEL = 'NO_USER_FACING_CHANGES';

/** Least-privileged audience type - the one that gets the tightest filter + scrubbing. */
const LEAST_PRIVILEGED_AUDIENCE_TYPE = 'customer';

const isLeastPrivileged = (variant: IVariantDescriptor): boolean =>
  variant.audienceType === LEAST_PRIVILEGED_AUDIENCE_TYPE;

/**
 * Builds the `<variant_scope>` block injected into the generation prompt for
 * one variant. Customer (least-privileged) variants get the audience-exclusion
 * clause; internal variants see all change types. Every variant gets the
 * uncertainty rule and the empty-result sentinel instruction.
 *
 * This product is single-deployment, so there is no deployment-scope line.
 */
export const buildVariantGuidance = (variant: IVariantDescriptor): string => {
  const audienceLine = isLeastPrivileged(variant)
    ? 'AUDIENCE: External customers. Apply the user-facing rules strictly — EXCLUDE ' +
      'internal/developer-facing changes (infrastructure, refactors, CI/CD, tooling, ' +
      'migrations, admin-only changes). Describe only user-visible benefits.'
    : 'AUDIENCE: Internal team members. All change types are in scope, including ' +
      'engineering and infrastructure work.';

  return [
    '<variant_scope>',
    audienceLine,
    'UNCERTAINTY: When unsure whether a change belongs in this variant, OMIT it.',
    `EMPTY: If nothing qualifies for this audience, return exactly ${NO_VARIANT_CONTENT_SENTINEL} ` +
      'rather than padding with internal work or content meant for another audience.',
    '</variant_scope>',
  ].join('\n');
};

/**
 * One internal->public substitution. `find` is applied globally; order matters,
 * so the rule list must be MOST-SPECIFIC-FIRST (e.g. an `org/repo` slug before
 * the bare `org` token) or a partial match can leave a half-rewritten string.
 */
export interface InternalReferenceRule {
  readonly find: RegExp;
  readonly replace: string;
}

/**
 * Public-facing product name used as the replacement for internal references.
 *
 * TODO(team): confirm against the brand config (open-core default appears to be
 * "Bike4Mind"). The scrub-verification test is the gate that keeps this honest.
 */
export const PUBLIC_PRODUCT_NAME = 'Bike4Mind';

/**
 * Team-maintained denylist of internal identifiers, ordered MOST-SPECIFIC-FIRST.
 * A new internal codename ships only with its scrub entry here - the
 * scrub-verification test enforces that contract.
 */
export const DEFAULT_INTERNAL_REFERENCE_RULES: readonly InternalReferenceRule[] = [
  // Repo slug before the bare org token (order matters).
  { find: /MillionOnMars\s*\/\s*lumina5/gi, replace: PUBLIC_PRODUCT_NAME },
  { find: /\bMillionOnMars\b/gi, replace: PUBLIC_PRODUCT_NAME },
  { find: /\blumina5\b/gi, replace: PUBLIC_PRODUCT_NAME },
  // TODO(team): add internal codenames / service names as they appear, most-specific-first.
];

/** Apply the rule list to a single string, in order. */
const applyRules = (text: string, rules: readonly InternalReferenceRule[]): string =>
  rules.reduce((acc, rule) => acc.replace(rule.find, rule.replace), text);

/**
 * Strip internal references from a single field of a less-privileged variant.
 * No-op for privileged (internal) variants and for empty input.
 */
export const scrubInternalReferences = (
  text: string,
  variant: IVariantDescriptor,
  rules: readonly InternalReferenceRule[] = DEFAULT_INTERNAL_REFERENCE_RULES
): string => {
  if (!text || !isLeastPrivileged(variant)) return text;
  return applyRules(text, rules);
};

/**
 * Scrub every audience-visible string field a variant contributes - not just a
 * primary text body. Non-string values pass through untouched.
 */
export const scrubVariantContent = (
  content: VariantContent,
  variant: IVariantDescriptor,
  rules: readonly InternalReferenceRule[] = DEFAULT_INTERNAL_REFERENCE_RULES
): VariantContent => {
  if (!isLeastPrivileged(variant)) return content;
  const scrubbed: VariantContent = {};
  for (const [field, value] of Object.entries(content)) {
    scrubbed[field] = typeof value === 'string' ? applyRules(value, rules) : value;
  }
  return scrubbed;
};

/**
 * True when generated text is the empty-result sentinel - exact match after
 * trim, NOT a substring check (a real line mentioning "no changes to X" must
 * not trip it). Blank/whitespace-only output is NOT the sentinel; the caller
 * treats that as a failure, since blank output is ambiguous.
 */
export const isNoVariantContent = (text: string | null | undefined): boolean =>
  (text ?? '').trim() === NO_VARIANT_CONTENT_SENTINEL;
