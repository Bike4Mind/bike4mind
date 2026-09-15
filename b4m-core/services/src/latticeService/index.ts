/**
 * Lattice Service
 *
 * Core services for the Lattice financial modeling system.
 */

// Dependency tracking
export {
  DependencyTracker,
  createDependencyTracker,
  type DependencyNode,
  type DependencyValidationResult,
  type AffectedRulesResult,
} from './DependencyTracker';

// Hydration (computation) engine
export { HydrationEngine, createHydrationEngine, type HydrationResult, type HydrationOptions } from './HydrationEngine';

// Explainer (calculation chains)
export {
  Explainer,
  createExplainer,
  type ExplainOptions,
  type FormattedExplanation,
  type FormattedStep,
} from './Explainer';

// Intent parsing (NLP to operations)
export {
  IntentParser,
  createIntentParser,
  type ParseOptions,
  type ParseResult,
  type LLMInterface,
} from './IntentParser';

// Model service (CRUD + persistence)
export * as latticeModelService from './latticeModelService';
export type {
  ILatticeModelRepository,
  LatticeModelServiceDeps,
  LatticeModelUser,
  CreateModelOptions,
  UpdateModelOptions,
  HydrationResult as ModelHydrationResult,
} from './latticeModelService';
