/**
 * audience-variants blueprint interfaces
 *
 * Portable kernel for the audience-variants pattern: the three named seams
 * any implementation must satisfy - variant registry, document shape, and
 * the server-side classifier contract.
 */

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** Stable identifier for one cell in the audience matrix. */
export type AudienceKey = string;

/** One variant descriptor in the registry. */
export interface IVariantDescriptor {
  /** Stable key - also the key in the document's `variants` map. */
  key: AudienceKey;
  /** Audience axis value (e.g. 'internal' | 'customer'). */
  audienceType: string;
  /** Human-readable label for admin UIs and status rows. */
  label: string;
}

// ---------------------------------------------------------------------------
// Document shape
// ---------------------------------------------------------------------------

/**
 * Per-variant content merged to the document top level at serve time.
 *
 * `undefined` means "field absent in this variant" - skipped by the merge so
 * it never clobbers a top-level default. `null` is an explicit value and
 * passes through. Consumers whose content is not purely textual can widen
 * this to `Record<string, unknown>`.
 */
export type VariantContent = Record<string, string | null | undefined>;

/**
 * Document shape that stores per-audience content.
 *
 * `variants` and `generationMetadata` are ALWAYS stripped before the document
 * is returned to any client - they must never appear in a serving-endpoint
 * response body.
 */
export interface IVariantDocument<K extends AudienceKey = AudienceKey> {
  /** All variants keyed by AudienceKey. Absent on legacy / non-variant docs. */
  variants?: Partial<Record<K, VariantContent>> | null;
  /** Internal generation metadata - stripped at serve time; never reaches clients. */
  generationMetadata?: unknown;
}

// ---------------------------------------------------------------------------
// Classifier (the named seam)
// ---------------------------------------------------------------------------

/**
 * Viewer context supplied to the classifier.
 *
 * Implementations extend this with the signals they need: user tags,
 * org flags, email domain, etc.
 */
export interface IViewerContext {
  organizationId?: string | null;
}

/**
 * Server-side pluggable classifier: resolves a viewer's audience key.
 *
 * Contract:
 * - MUST be called server-side only; never trust a client-supplied key.
 * - `classify` MAY throw (database blip, missing tag). It does NOT swallow
 *   its own errors. Fail-open is the serving handler's responsibility: it
 *   wraps `classify` in a try/catch and substitutes `safeDefaultKey`.
 * - Fail-open lives at the serving call site, NOT inside `classify` and NOT
 *   inside any shared data helper the classifier reads from.
 */
export interface IViewerClassifier<K extends AudienceKey = AudienceKey> {
  /** Resolve the viewer's audience key. May throw - the serving handler catches. */
  classify(context: IViewerContext): K | Promise<K>;
  /** Substituted by the serving handler when `classify` throws - must name the least-privileged key. */
  readonly safeDefaultKey: K;
}

// ---------------------------------------------------------------------------
// Leak guard
// ---------------------------------------------------------------------------

/**
 * Serve-time leak guard.
 *
 * Invariants:
 * - Applied to EVERY viewer, including admins. Never bypassed.
 * - Returns the document with the viewer's variant fields merged to the top
 *   level, and `variants` + `generationMetadata` removed. Only DEFINED
 *   variant fields are merged - `undefined` must not clobber a top-level
 *   value (explicit `null` passes through intentionally).
 * - Returns `null` when the document has no content for this audience key.
 * - Legacy documents without a `variants` map are returned unchanged minus
 *   `generationMetadata` - backwards compatibility.
 * - Pure and side-effect-free - unit-testable without a database.
 */
export type ExtractVariantForViewer<
  D extends IVariantDocument = IVariantDocument,
  K extends AudienceKey = AudienceKey,
> = (doc: D, audienceKey: K) => Omit<D, 'variants' | 'generationMetadata'> | null;

// ---------------------------------------------------------------------------
// Generation-time prompt scoping (optional)
// ---------------------------------------------------------------------------

/**
 * Builds a `<variant_scope>` block to inject into an LLM prompt at generation
 * time, scoping the call to one variant. For less-privileged (customer)
 * variants the block adds an audience-exclusion clause; all variants get an
 * uncertainty rule and an empty-result sentinel instruction.
 *
 * Optional - consumers that author content by hand or use a non-LLM pipeline
 * do not implement this.
 */
export type BuildVariantGuidance = (variant: IVariantDescriptor) => string;
