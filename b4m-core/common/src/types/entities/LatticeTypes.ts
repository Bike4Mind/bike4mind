/**
 * Lattice Types
 *
 * Core type definitions for the Lattice financial modeling system.
 * Lattice separates financial models into three distinct layers:
 * - Data Layer: Entities, values, relationships
 * - Rules Layer: Formulas and logic as first-class objects
 * - View Layer: Presentation configuration
 */

// =============================================================================
// ENUMS & BASIC TYPES
// =============================================================================

/**
 * Primitive value types that can be stored in attributes
 */
export type PrimitiveValue = number | string | boolean | Date | null;

/**
 * Data types for attributes and outputs
 */
export type LatticeDataType = 'number' | 'currency' | 'percentage' | 'string' | 'boolean' | 'date' | 'datetime';

/**
 * Entity types in a financial model
 */
export type LatticeEntityType =
  | 'line_item' // Revenue, COGS, Expenses
  | 'account' // Cash, AR, AP, Inventory
  | 'period' // Q1 2024, FY2025
  | 'category' // Operating Expenses, Cost of Sales
  | 'scenario' // Base, Upside, Downside
  | 'custom';

/**
 * Relationship types between entities
 */
export type LatticeRelationshipType =
  | 'parent_child' // Category → Line Item
  | 'temporal' // Q1 → Q2 → Q3
  | 'reference' // Lookup relationship
  | 'derived'; // Computed dependency

/**
 * Rule types for different computation patterns
 */
export type LatticeRuleType =
  | 'formula' // Computed value
  | 'aggregation' // SUM, AVG, etc.
  | 'constraint' // Validation rule
  | 'transformation' // Data transformation
  | 'conditional'; // IF/THEN logic

/**
 * Operations supported in rules
 */
export type LatticeOperation =
  // Arithmetic
  | 'ADD'
  | 'SUBTRACT'
  | 'MULTIPLY'
  | 'DIVIDE'
  | 'ABS'
  | 'ROUND'
  | 'FLOOR'
  | 'CEIL'
  | 'POWER'
  | 'SQRT'
  // Aggregation
  | 'SUM'
  | 'AVERAGE'
  | 'MIN'
  | 'MAX'
  | 'COUNT'
  | 'MEDIAN'
  // Logical
  | 'IF'
  | 'AND'
  | 'OR'
  | 'NOT'
  | 'EQUALS'
  | 'GREATER_THAN'
  | 'LESS_THAN'
  | 'GREATER_THAN_OR_EQUAL'
  | 'LESS_THAN_OR_EQUAL'
  | 'BETWEEN'
  // Financial
  | 'PERCENT_OF'
  | 'GROWTH_RATE'
  | 'NPV'
  | 'IRR'
  | 'PMT'
  | 'FV'
  | 'PV'
  // Special
  | 'REFERENCE'
  | 'LOOKUP';

/**
 * Condition operators for rule conditions
 */
export type LatticeConditionOperator = '==' | '!=' | '>' | '<' | '>=' | '<=' | 'contains' | 'in';

/**
 * Period grain for time-based models
 */
export type LatticePeriodGrain = 'day' | 'week' | 'month' | 'quarter' | 'year';

/**
 * Format for negative numbers
 */
export type LatticeNegativeFormat = 'parentheses' | 'minus' | 'red';

/**
 * View types for presentation
 */
export type LatticeViewType =
  | 'table' // Standard row/column grid
  | 'pivot' // Grouped aggregation
  | 'time_series' // Data over time
  | 'comparison' // Side-by-side scenarios
  | 'summary_card' // Single KPI
  | 'waterfall' // Change breakdown
  | 'tree'; // Hierarchical view

/**
 * Model types for templates
 */
export type LatticeModelType =
  | 'income_statement'
  | 'balance_sheet'
  | 'cashflow'
  | 'saas_metrics'
  | 'dcf'
  | 'lbo'
  | 'custom';

/**
 * Intent types for NLP parsing
 */
export type LatticeIntentType =
  | 'CREATE_ENTITY'
  | 'SET_VALUE'
  | 'CREATE_RULE'
  | 'QUERY_VALUE'
  | 'QUERY_AGGREGATE'
  | 'CREATE_VIEW'
  | 'COMPARE'
  | 'FORECAST'
  | 'EXPLAIN'
  | 'UNDO'
  | 'REDO'
  | 'LIST'
  | 'DELETE'
  | 'AMBIGUOUS';

/**
 * Error types for Lattice operations
 */
export type LatticeErrorType =
  | 'PARSE_ERROR'
  | 'AMBIGUOUS_REFERENCE'
  | 'ENTITY_NOT_FOUND'
  | 'RULE_NOT_FOUND'
  | 'CIRCULAR_DEPENDENCY'
  | 'TYPE_MISMATCH'
  | 'DIVISION_BY_ZERO'
  | 'MISSING_DATA'
  | 'INVALID_PERIOD'
  | 'CONSTRAINT_VIOLATION'
  | 'INVALID_OPERATION';

// =============================================================================
// DATA LAYER
// =============================================================================

/**
 * An attribute holds a value for a specific key (often a period)
 */
export interface ILatticeAttribute {
  key: string; // Period key or attribute name (e.g., 'Q1_2024', 'description')
  value: PrimitiveValue;
  dataType: LatticeDataType;
  isComputed: boolean; // True if derived from a rule
  computedByRuleId?: string;
  timestamp?: number; // For time-series support
  metadata?: Record<string, unknown>;
}

/**
 * An entity represents a line item, account, period, or other model element
 */
export interface ILatticeEntity {
  id: string;
  type: LatticeEntityType;
  name: string;
  displayName?: string;
  attributes: ILatticeAttribute[];
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A relationship connects two entities
 */
export interface ILatticeRelationship {
  id: string;
  type: LatticeRelationshipType;
  fromEntityId: string;
  toEntityId: string;
  metadata?: Record<string, unknown>;
}

/**
 * The data store holds all entities and relationships
 */
export interface ILatticeDataStore {
  entities: ILatticeEntity[];
  relationships: ILatticeRelationship[];
}

// =============================================================================
// RULES LAYER
// =============================================================================

/**
 * An input to a rule (can be an entity, attribute, another rule, or literal)
 */
export interface ILatticeInput {
  type: 'entity' | 'attribute' | 'rule' | 'literal' | 'range';
  ref: string; // Entity ID, rule ID, or literal value
  selector?: string; // Attribute key or range selector ('*' for all)
}

/**
 * Output target for a rule
 */
export interface ILatticeOutput {
  targetEntityId: string;
  targetAttribute: string; // '*' applies to all periods
  dataType: LatticeDataType;
}

/**
 * A condition for conditional rules
 */
export interface ILatticeCondition {
  left: ILatticeInput;
  operator: LatticeConditionOperator;
  right: ILatticeInput;
  logicalJoin?: 'AND' | 'OR';
}

/**
 * The definition of how a rule computes its output
 */
export interface ILatticeRuleDefinition {
  operation: LatticeOperation;
  inputs: ILatticeInput[];
  output: ILatticeOutput;
  conditions?: ILatticeCondition[];
}

/**
 * A rule defines a computation or constraint
 */
export interface ILatticeRule {
  id: string;
  name: string;
  description?: string;
  type: LatticeRuleType;
  definition: ILatticeRuleDefinition;
  dependencies: string[]; // Entity/rule IDs this rule depends on
  priority: number; // For conflict resolution (higher = runs later)
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A ruleset groups related rules
 */
export interface ILatticeRuleset {
  id: string;
  name: string;
  ruleIds: string[];
  description?: string;
}

/**
 * The rules store holds all rules and rulesets
 */
export interface ILatticeRulesStore {
  rules: ILatticeRule[];
  rulesets: ILatticeRuleset[];
}

// =============================================================================
// VIEW LAYER
// =============================================================================

/**
 * Row configuration for a view
 */
export interface ILatticeRowConfig {
  source: 'entity' | 'rule' | 'category';
  ref: string;
  label?: string;
  indent?: number; // For hierarchical display
  isSummary?: boolean; // Bold/highlight as summary row
}

/**
 * Column configuration for a view
 */
export interface ILatticeColumnConfig {
  source: 'period' | 'scenario' | 'attribute' | 'computed';
  ref: string;
  label?: string;
  width?: number;
}

/**
 * Filter for a view
 */
export interface ILatticeFilter {
  field: string;
  operator: LatticeConditionOperator;
  value: PrimitiveValue;
}

/**
 * Sort configuration
 */
export interface ILatticeSortConfig {
  field: string;
  direction: 'asc' | 'desc';
}

/**
 * Grouping configuration
 */
export interface ILatticeGroupConfig {
  groupBy: string[];
  aggregation: LatticeOperation;
}

/**
 * Formatting configuration for a view
 */
export interface ILatticeFormatConfig {
  numberFormat?: string; // e.g., '#,##0.00'
  currencySymbol?: string;
  percentageDecimals?: number;
  negativeFormat?: LatticeNegativeFormat;
  showGridLines?: boolean;
  zebra?: boolean; // Alternating row colors
  compactMode?: boolean;
}

/**
 * Complete view configuration
 */
export interface ILatticeViewConfig {
  rows?: ILatticeRowConfig[];
  columns?: ILatticeColumnConfig[];
  filters?: ILatticeFilter[];
  sorting?: ILatticeSortConfig[];
  grouping?: ILatticeGroupConfig;
  formatting?: ILatticeFormatConfig;
}

/**
 * A view defines how to present the model
 */
export interface ILatticeView {
  id: string;
  type: LatticeViewType;
  name: string;
  config: ILatticeViewConfig;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The view store holds all views
 */
export interface ILatticeViewStore {
  views: ILatticeView[];
  activeViewId?: string;
}

// =============================================================================
// MODEL SETTINGS
// =============================================================================

/**
 * Model-level settings
 */
export interface ILatticeModelSettings {
  currency: string; // Default: 'USD'
  fiscalYearStart: string; // Default: '01-01' (MM-DD)
  periodGrain: LatticePeriodGrain;
  defaultDecimalPlaces: number; // Default: 2
  negativeFormat: LatticeNegativeFormat;
}

// =============================================================================
// OPERATIONS & HISTORY
// =============================================================================

/**
 * Operation types for undo/redo
 */
export type LatticeOperationType =
  | 'CREATE_ENTITY'
  | 'UPDATE_ENTITY'
  | 'DELETE_ENTITY'
  | 'CREATE_RULE'
  | 'UPDATE_RULE'
  | 'DELETE_RULE'
  | 'SET_VALUE'
  | 'CREATE_VIEW'
  | 'UPDATE_VIEW'
  | 'DELETE_VIEW'
  | 'CREATE_SCENARIO'
  | 'UPDATE_SCENARIO'
  | 'DELETE_SCENARIO'
  | 'UPDATE_SETTINGS';

/**
 * An operation for the undo/redo stack
 */
export interface ILatticeOperation {
  id: string;
  type: LatticeOperationType;
  timestamp: Date;
  data: Record<string, unknown>; // Operation-specific data
  inverse: Record<string, unknown>; // Data to undo this operation
  description: string; // Human-readable description
  messageId?: string; // Link to chat message that triggered this
}

// =============================================================================
// SCENARIOS
// =============================================================================

/**
 * A scenario override for a specific value
 */
export interface ILatticeScenarioOverride {
  entityId: string;
  attributeKey: string;
  value: PrimitiveValue;
}

/**
 * A scenario is a set of overrides for what-if analysis
 */
export interface ILatticeScenario {
  id: string;
  name: string;
  description?: string;
  overrides: ILatticeScenarioOverride[];
  createdAt: Date;
  updatedAt: Date;
}

// =============================================================================
// COMPUTED VALUES
// =============================================================================

/**
 * A single computed value with metadata
 */
export interface ILatticeComputedValue {
  value: PrimitiveValue;
  computedByRuleId: string;
  computedAt: Date;
}

/**
 * All computed values for a model
 * Structure: { [entityId]: { [attributeKey]: ComputedValue } }
 */
export interface ILatticeComputedValues {
  [entityId: string]: {
    [attributeKey: string]: ILatticeComputedValue;
  };
}

// =============================================================================
// CALCULATION CHAIN (FOR EXPLAINABILITY)
// =============================================================================

/**
 * A step in a calculation chain
 */
export interface ILatticeCalculationStep {
  ruleId: string;
  ruleName: string;
  operation: LatticeOperation;
  inputs: Array<{ name: string; value: PrimitiveValue }>;
  output: PrimitiveValue;
}

/**
 * A calculation chain explains how a value was computed
 */
export interface ILatticeCalculationChain {
  targetEntity: string;
  targetAttribute: string;
  finalValue: PrimitiveValue;
  steps: ILatticeCalculationStep[];
}

// =============================================================================
// MAIN MODEL
// =============================================================================

/**
 * The complete Lattice model
 */
export interface ILatticeModel {
  // Identity
  id: string;
  name: string;
  description?: string;
  modelType: LatticeModelType;

  // Ownership
  userId: string;
  sessionId?: string;
  projectId?: string;
  organizationId?: string;

  // Core Data Layers
  data: ILatticeDataStore;
  rules: ILatticeRulesStore;
  views: ILatticeViewStore;

  // Settings
  settings: ILatticeModelSettings;

  // Scenarios
  scenarios: ILatticeScenario[];
  activeScenarioId?: string;

  // History
  operations: ILatticeOperation[];
  operationIndex: number; // Current position in undo stack

  // Versioning
  version: number;
  contentHash?: string;

  // Timestamps
  createdAt: Date;
  updatedAt: Date;
  lastComputedAt?: Date;

  // Soft delete
  deletedAt?: Date;
}

// =============================================================================
// NLP / INTENT PARSING
// =============================================================================

/**
 * An extracted entity from NLP parsing
 */
export interface ILatticeExtractedEntity {
  type:
    | 'line_item_name'
    | 'period'
    | 'amount'
    | 'percentage'
    | 'operation'
    | 'comparison_operator'
    | 'entity_reference'
    | 'category'
    | 'scenario';
  value: string;
  normalizedValue?: string | number;
  position: { start: number; end: number };
  confidence: number;
}

/**
 * A parsed intent from NLP
 */
export interface ILatticeParsedIntent {
  intent: LatticeIntentType;
  confidence: number;
  entities: ILatticeExtractedEntity[];
  rawInput: string;
  normalizedInput: string;
  suggestedOperations?: ILatticeOperation[];
  ambiguousRefs?: Array<{
    value: string;
    candidates: string[];
  }>;
  clarificationNeeded?: string;
}

// =============================================================================
// ERROR HANDLING
// =============================================================================

/**
 * A Lattice error with context
 */
export interface ILatticeError {
  type: LatticeErrorType;
  message: string;
  suggestions?: string[];
  context?: {
    input?: string;
    position?: number;
    relatedEntities?: string[];
    relatedRules?: string[];
  };
}

// =============================================================================
// API TYPES
// =============================================================================

/**
 * Request to create a new model
 */
export interface ICreateLatticeModelRequest {
  name: string;
  description?: string;
  modelType?: LatticeModelType;
  sessionId?: string;
  projectId?: string;
  settings?: Partial<ILatticeModelSettings>;
}

/**
 * Request to update a model
 */
export interface IUpdateLatticeModelRequest {
  name?: string;
  description?: string;
  settings?: Partial<ILatticeModelSettings>;
  data?: ILatticeDataStore;
  rules?: ILatticeRulesStore;
  views?: ILatticeViewStore;
}

/**
 * Request to compute model values
 */
export interface IComputeLatticeRequest {
  scenarioId?: string;
}

/**
 * Response from computation
 */
export interface IComputeLatticeResponse {
  computedValues: ILatticeComputedValues;
  duration: number;
  errors?: ILatticeError[];
}

/**
 * Request to explain a calculation
 */
export interface IExplainLatticeRequest {
  entityId: string;
  attributeKey: string;
}

/**
 * Response with calculation explanation
 */
export interface IExplainLatticeResponse {
  chain: ILatticeCalculationChain;
}

/**
 * Export format options
 */
export type LatticeExportFormat = 'csv' | 'json' | 'xlsx';

/**
 * Request to export a model
 */
export interface IExportLatticeRequest {
  format: LatticeExportFormat;
  viewId?: string; // If not specified, exports raw data
  scenarioId?: string;
}

// =============================================================================
// ARTIFACT INTEGRATION
// =============================================================================

/**
 * Lattice artifact metadata
 */
export interface ILatticeArtifactMetadata {
  modelType: LatticeModelType;
  periodGrain: LatticePeriodGrain;
  currency: string;
  entityCount: number;
  ruleCount: number;
  scenarioCount: number;
}
