/**
 * Lattice Zod Schemas
 *
 * Validation schemas for the Lattice financial modeling system.
 */

import { z } from 'zod';

// ENUM SCHEMAS

export const LatticeDataTypeSchema = z.enum([
  'number',
  'currency',
  'percentage',
  'string',
  'boolean',
  'date',
  'datetime',
]);

export const LatticeEntityTypeSchema = z.enum(['line_item', 'account', 'period', 'category', 'scenario', 'custom']);

export const LatticeRelationshipTypeSchema = z.enum(['parent_child', 'temporal', 'reference', 'derived']);

export const LatticeRuleTypeSchema = z.enum(['formula', 'aggregation', 'constraint', 'transformation', 'conditional']);

export const LatticeOperationSchema = z.enum([
  // Arithmetic
  'ADD',
  'SUBTRACT',
  'MULTIPLY',
  'DIVIDE',
  'ABS',
  'ROUND',
  'FLOOR',
  'CEIL',
  'POWER',
  'SQRT',
  // Aggregation
  'SUM',
  'AVERAGE',
  'MIN',
  'MAX',
  'COUNT',
  'MEDIAN',
  // Logical
  'IF',
  'AND',
  'OR',
  'NOT',
  'EQUALS',
  'GREATER_THAN',
  'LESS_THAN',
  'GREATER_THAN_OR_EQUAL',
  'LESS_THAN_OR_EQUAL',
  'BETWEEN',
  // Financial
  'PERCENT_OF',
  'GROWTH_RATE',
  'NPV',
  'IRR',
  'PMT',
  'FV',
  'PV',
  // Special
  'REFERENCE',
  'LOOKUP',
]);

export const LatticeConditionOperatorSchema = z.enum(['==', '!=', '>', '<', '>=', '<=', 'contains', 'in']);

export const LatticePeriodGrainSchema = z.enum(['day', 'week', 'month', 'quarter', 'year']);

export const LatticeNegativeFormatSchema = z.enum(['parentheses', 'minus', 'red']);

export const LatticeViewTypeSchema = z.enum([
  'table',
  'pivot',
  'time_series',
  'comparison',
  'summary_card',
  'waterfall',
  'tree',
]);

export const LatticeModelTypeSchema = z.enum([
  'income_statement',
  'balance_sheet',
  'cashflow',
  'saas_metrics',
  'dcf',
  'lbo',
  'custom',
]);

export const LatticeIntentTypeSchema = z.enum([
  'CREATE_ENTITY',
  'SET_VALUE',
  'CREATE_RULE',
  'QUERY_VALUE',
  'QUERY_AGGREGATE',
  'CREATE_VIEW',
  'COMPARE',
  'FORECAST',
  'EXPLAIN',
  'UNDO',
  'REDO',
  'LIST',
  'DELETE',
  'AMBIGUOUS',
]);

export const LatticeErrorTypeSchema = z.enum([
  'PARSE_ERROR',
  'AMBIGUOUS_REFERENCE',
  'ENTITY_NOT_FOUND',
  'RULE_NOT_FOUND',
  'CIRCULAR_DEPENDENCY',
  'TYPE_MISMATCH',
  'DIVISION_BY_ZERO',
  'MISSING_DATA',
  'INVALID_PERIOD',
  'CONSTRAINT_VIOLATION',
  'INVALID_OPERATION',
]);

export const LatticeOperationTypeSchema = z.enum([
  'CREATE_ENTITY',
  'UPDATE_ENTITY',
  'DELETE_ENTITY',
  'CREATE_RULE',
  'UPDATE_RULE',
  'DELETE_RULE',
  'SET_VALUE',
  'CREATE_VIEW',
  'UPDATE_VIEW',
  'DELETE_VIEW',
  'CREATE_SCENARIO',
  'UPDATE_SCENARIO',
  'DELETE_SCENARIO',
  'UPDATE_SETTINGS',
]);

export const LatticeExportFormatSchema = z.enum(['csv', 'json', 'xlsx']);

// PRIMITIVE VALUE SCHEMA

export const LatticePrimitiveValueSchema = z.union([z.number(), z.string(), z.boolean(), z.date(), z.null()]);

// DATA LAYER SCHEMAS

export const LatticeAttributeSchema = z.object({
  key: z.string().min(1).max(100),
  value: LatticePrimitiveValueSchema,
  dataType: LatticeDataTypeSchema,
  isComputed: z.boolean().prefault(false),
  computedByRuleId: z.string().optional(),
  timestamp: z.number().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const LatticeEntitySchema = z.object({
  id: z.string().min(1).max(100),
  type: LatticeEntityTypeSchema,
  name: z.string().min(1).max(255),
  displayName: z.string().max(255).optional(),
  attributes: z.array(LatticeAttributeSchema).prefault([]),
  metadata: z.record(z.string(), z.unknown()).prefault({}),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const LatticeRelationshipSchema = z.object({
  id: z.string().min(1).max(100),
  type: LatticeRelationshipTypeSchema,
  fromEntityId: z.string(),
  toEntityId: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const LatticeDataStoreSchema = z.object({
  entities: z.array(LatticeEntitySchema).prefault([]),
  relationships: z.array(LatticeRelationshipSchema).prefault([]),
});

// RULES LAYER SCHEMAS

export const LatticeInputSchema = z.object({
  type: z.enum(['entity', 'attribute', 'rule', 'literal', 'range']),
  ref: z.string(),
  selector: z.string().optional(),
});

export const LatticeOutputSchema = z.object({
  targetEntityId: z.string(),
  targetAttribute: z.string(),
  dataType: LatticeDataTypeSchema,
});

export const LatticeConditionSchema = z.object({
  left: LatticeInputSchema,
  operator: LatticeConditionOperatorSchema,
  right: LatticeInputSchema,
  logicalJoin: z.enum(['AND', 'OR']).optional(),
});

export const LatticeRuleDefinitionSchema = z.object({
  operation: LatticeOperationSchema,
  inputs: z.array(LatticeInputSchema).min(1),
  output: LatticeOutputSchema,
  conditions: z.array(LatticeConditionSchema).optional(),
});

export const LatticeRuleSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().min(1).max(255),
  description: z.string().max(1000).optional(),
  type: LatticeRuleTypeSchema,
  definition: LatticeRuleDefinitionSchema,
  dependencies: z.array(z.string()).prefault([]),
  priority: z.int().prefault(0),
  enabled: z.boolean().prefault(true),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const LatticeRulesetSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().min(1).max(255),
  ruleIds: z.array(z.string()).prefault([]),
  description: z.string().max(1000).optional(),
});

export const LatticeRulesStoreSchema = z.object({
  rules: z.array(LatticeRuleSchema).prefault([]),
  rulesets: z.array(LatticeRulesetSchema).prefault([]),
});

// VIEW LAYER SCHEMAS

export const LatticeRowConfigSchema = z.object({
  source: z.enum(['entity', 'rule', 'category']),
  ref: z.string(),
  label: z.string().optional(),
  indent: z.int().min(0).max(10).optional(),
  isSummary: z.boolean().optional(),
});

export const LatticeColumnConfigSchema = z.object({
  source: z.enum(['period', 'scenario', 'attribute', 'computed']),
  ref: z.string(),
  label: z.string().optional(),
  width: z.number().positive().optional(),
});

export const LatticeFilterSchema = z.object({
  field: z.string(),
  operator: LatticeConditionOperatorSchema,
  value: LatticePrimitiveValueSchema,
});

export const LatticeSortConfigSchema = z.object({
  field: z.string(),
  direction: z.enum(['asc', 'desc']),
});

export const LatticeGroupConfigSchema = z.object({
  groupBy: z.array(z.string()),
  aggregation: LatticeOperationSchema,
});

export const LatticeFormatConfigSchema = z.object({
  numberFormat: z.string().optional(),
  currencySymbol: z.string().max(10).optional(),
  percentageDecimals: z.int().min(0).max(10).optional(),
  negativeFormat: LatticeNegativeFormatSchema.optional(),
  showGridLines: z.boolean().optional(),
  zebra: z.boolean().optional(),
  compactMode: z.boolean().optional(),
});

export const LatticeViewConfigSchema = z.object({
  rows: z.array(LatticeRowConfigSchema).optional(),
  columns: z.array(LatticeColumnConfigSchema).optional(),
  filters: z.array(LatticeFilterSchema).optional(),
  sorting: z.array(LatticeSortConfigSchema).optional(),
  grouping: LatticeGroupConfigSchema.optional(),
  formatting: LatticeFormatConfigSchema.optional(),
});

export const LatticeViewSchema = z.object({
  id: z.string().min(1).max(100),
  type: LatticeViewTypeSchema,
  name: z.string().min(1).max(255),
  config: LatticeViewConfigSchema,
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const LatticeViewStoreSchema = z.object({
  views: z.array(LatticeViewSchema).prefault([]),
  activeViewId: z.string().optional(),
});

// SETTINGS SCHEMA

export const LatticeModelSettingsSchema = z.object({
  currency: z.string().min(1).max(10).prefault('USD'),
  fiscalYearStart: z
    .string()
    .regex(/^\d{2}-\d{2}$/)
    .prefault('01-01'),
  periodGrain: LatticePeriodGrainSchema.prefault('quarter'),
  defaultDecimalPlaces: z.int().min(0).max(10).prefault(2),
  negativeFormat: LatticeNegativeFormatSchema.prefault('parentheses'),
});

// OPERATIONS & HISTORY SCHEMAS

export const LatticeHistoryOperationSchema = z.object({
  id: z.string(),
  type: LatticeOperationTypeSchema,
  timestamp: z.date(),
  data: z.record(z.string(), z.unknown()),
  inverse: z.record(z.string(), z.unknown()),
  description: z.string(),
  messageId: z.string().optional(),
});

// SCENARIOS SCHEMAS

export const LatticeScenarioOverrideSchema = z.object({
  entityId: z.string(),
  attributeKey: z.string(),
  value: LatticePrimitiveValueSchema,
});

export const LatticeScenarioSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().min(1).max(255),
  description: z.string().max(1000).optional(),
  overrides: z.array(LatticeScenarioOverrideSchema).prefault([]),
  createdAt: z.date(),
  updatedAt: z.date(),
});

// COMPUTED VALUES SCHEMAS

export const LatticeComputedValueSchema = z.object({
  value: LatticePrimitiveValueSchema,
  computedByRuleId: z.string(),
  computedAt: z.date(),
});

export const LatticeComputedValuesSchema = z.record(z.string(), z.record(z.string(), LatticeComputedValueSchema));

// CALCULATION CHAIN SCHEMAS

export const LatticeCalculationStepSchema = z.object({
  ruleId: z.string(),
  ruleName: z.string(),
  operation: LatticeOperationSchema,
  inputs: z.array(
    z.object({
      name: z.string(),
      value: LatticePrimitiveValueSchema,
    })
  ),
  output: LatticePrimitiveValueSchema,
});

export const LatticeCalculationChainSchema = z.object({
  targetEntity: z.string(),
  targetAttribute: z.string(),
  finalValue: LatticePrimitiveValueSchema,
  steps: z.array(LatticeCalculationStepSchema),
});

// MAIN MODEL SCHEMA

export const LatticeModelSchema = z.object({
  // Identity
  id: z.string().min(1).max(100),
  name: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
  modelType: LatticeModelTypeSchema.prefault('custom'),

  // Ownership
  userId: z.string(),
  sessionId: z.string().optional(),
  projectId: z.string().optional(),
  organizationId: z.string().optional(),

  // Core Data Layers
  data: LatticeDataStoreSchema.prefault({ entities: [], relationships: [] }),
  rules: LatticeRulesStoreSchema.prefault({ rules: [], rulesets: [] }),
  views: LatticeViewStoreSchema.prefault({ views: [] }),

  // Settings
  settings: LatticeModelSettingsSchema.prefault({}),

  // Scenarios
  scenarios: z.array(LatticeScenarioSchema).prefault([]),
  activeScenarioId: z.string().optional(),

  // History
  operations: z.array(LatticeHistoryOperationSchema).prefault([]),
  operationIndex: z.int().min(-1).prefault(-1),

  // Versioning
  version: z.int().positive().prefault(1),
  contentHash: z.string().optional(),

  // Timestamps
  createdAt: z.date(),
  updatedAt: z.date(),
  lastComputedAt: z.date().optional(),

  // Soft delete
  deletedAt: z.date().optional(),
});

// NLP / INTENT PARSING SCHEMAS

export const LatticeExtractedEntitySchema = z.object({
  type: z.enum([
    'line_item_name',
    'period',
    'amount',
    'percentage',
    'operation',
    'comparison_operator',
    'entity_reference',
    'category',
    'scenario',
  ]),
  value: z.string(),
  normalizedValue: z.union([z.string(), z.number()]).optional(),
  position: z.object({
    start: z.int().min(0),
    end: z.int().min(0),
  }),
  confidence: z.number().min(0).max(1),
});

export const LatticeParsedIntentSchema = z.object({
  intent: LatticeIntentTypeSchema,
  confidence: z.number().min(0).max(1),
  entities: z.array(LatticeExtractedEntitySchema),
  rawInput: z.string(),
  normalizedInput: z.string(),
  suggestedOperations: z.array(LatticeHistoryOperationSchema).optional(),
  ambiguousRefs: z
    .array(
      z.object({
        value: z.string(),
        candidates: z.array(z.string()),
      })
    )
    .optional(),
  clarificationNeeded: z.string().optional(),
});

// ERROR SCHEMA

export const LatticeErrorSchema = z.object({
  type: LatticeErrorTypeSchema,
  message: z.string(),
  suggestions: z.array(z.string()).optional(),
  context: z
    .object({
      input: z.string().optional(),
      position: z.number().optional(),
      relatedEntities: z.array(z.string()).optional(),
      relatedRules: z.array(z.string()).optional(),
    })
    .optional(),
});

// API REQUEST/RESPONSE SCHEMAS

export const CreateLatticeModelRequestSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
  modelType: LatticeModelTypeSchema.optional(),
  sessionId: z.string().optional(),
  projectId: z.string().optional(),
  settings: LatticeModelSettingsSchema.partial().optional(),
});

export const UpdateLatticeModelRequestSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(2000).optional(),
  settings: LatticeModelSettingsSchema.partial().optional(),
  data: LatticeDataStoreSchema.optional(),
  rules: LatticeRulesStoreSchema.optional(),
  views: LatticeViewStoreSchema.optional(),
});

export const ComputeLatticeRequestSchema = z.object({
  scenarioId: z.string().optional(),
});

export const ComputeLatticeResponseSchema = z.object({
  computedValues: LatticeComputedValuesSchema,
  duration: z.number(),
  errors: z.array(LatticeErrorSchema).optional(),
});

export const ExplainLatticeRequestSchema = z.object({
  entityId: z.string(),
  attributeKey: z.string(),
});

export const ExplainLatticeResponseSchema = z.object({
  chain: LatticeCalculationChainSchema,
});

export const ExportLatticeRequestSchema = z.object({
  format: LatticeExportFormatSchema,
  viewId: z.string().optional(),
  scenarioId: z.string().optional(),
});

// INFERRED TYPES

// Use I-prefixed interfaces from '../types/entities/LatticeTypes' for canonical types
// The Zod schemas here are for runtime validation

// VALIDATION HELPERS

export const validateLatticeModel = (data: unknown): z.infer<typeof LatticeModelSchema> => {
  return LatticeModelSchema.parse(data);
};

export const validateLatticeEntity = (data: unknown): z.infer<typeof LatticeEntitySchema> => {
  return LatticeEntitySchema.parse(data);
};

export const validateLatticeRule = (data: unknown): z.infer<typeof LatticeRuleSchema> => {
  return LatticeRuleSchema.parse(data);
};

export const validateLatticeParsedIntent = (data: unknown): z.infer<typeof LatticeParsedIntentSchema> => {
  return LatticeParsedIntentSchema.parse(data);
};

export const safeParseLatticeModel = (data: unknown) => {
  return LatticeModelSchema.safeParse(data);
};

export const safeParseLatticeEntity = (data: unknown) => {
  return LatticeEntitySchema.safeParse(data);
};

export const safeParseLatticeRule = (data: unknown) => {
  return LatticeRuleSchema.safeParse(data);
};
