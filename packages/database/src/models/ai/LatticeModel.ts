/**
 * MongoDB model for Lattice financial models.
 * Three-layer architecture: Data, Rules, Views.
 */

import mongoose, { Schema, Document, Model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';
import { softDeletePlugin } from '../../utils/mongo';
import type {
  ILatticeModel,
  ILatticeEntity,
  ILatticeAttribute,
  ILatticeRelationship,
  ILatticeRule,
  ILatticeRuleDefinition,
  ILatticeInput,
  ILatticeOutput,
  ILatticeCondition,
  ILatticeRuleset,
  ILatticeView,
  ILatticeViewConfig,
  ILatticeRowConfig,
  ILatticeColumnConfig,
  ILatticeFilter,
  ILatticeSortConfig,
  ILatticeGroupConfig,
  ILatticeFormatConfig,
  ILatticeModelSettings,
  ILatticeOperation,
  ILatticeScenario,
  ILatticeScenarioOverride,
} from '@bike4mind/common';

// DOCUMENT INTERFACE

export interface ILatticeModelDocument extends Omit<ILatticeModel, 'id'>, Document {
  id: string;
}

export interface ILatticeModelModel extends Model<ILatticeModelDocument> {}

// NESTED SCHEMAS (no auto _id for embedded documents)

// --- Data Layer ---

const LatticeAttributeSchema = new Schema<ILatticeAttribute>(
  {
    key: { type: String, required: true },
    value: { type: Schema.Types.Mixed },
    dataType: {
      type: String,
      enum: ['number', 'currency', 'percentage', 'string', 'boolean', 'date', 'datetime'],
      default: 'number',
    },
    isComputed: { type: Boolean, default: false },
    computedByRuleId: { type: String },
    timestamp: { type: Number },
    metadata: { type: Schema.Types.Mixed },
  },
  { _id: false }
);

const LatticeEntitySchema = new Schema<ILatticeEntity>(
  {
    id: { type: String, required: true },
    type: {
      type: String,
      enum: ['line_item', 'account', 'period', 'category', 'scenario', 'custom'],
      required: true,
    },
    name: { type: String, required: true },
    displayName: { type: String },
    attributes: [LatticeAttributeSchema],
    metadata: { type: Schema.Types.Mixed, default: {} },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const LatticeRelationshipSchema = new Schema<ILatticeRelationship>(
  {
    id: { type: String, required: true },
    type: {
      type: String,
      enum: ['parent_child', 'temporal', 'reference', 'derived'],
      required: true,
    },
    fromEntityId: { type: String, required: true },
    toEntityId: { type: String, required: true },
    metadata: { type: Schema.Types.Mixed },
  },
  { _id: false }
);

const LatticeDataStoreSchema = new Schema(
  {
    entities: [LatticeEntitySchema],
    relationships: [LatticeRelationshipSchema],
  },
  { _id: false }
);

// --- Rules Layer ---

const LatticeInputSchema = new Schema<ILatticeInput>(
  {
    type: {
      type: String,
      enum: ['entity', 'attribute', 'rule', 'literal', 'range'],
      required: true,
    },
    ref: { type: String, required: true },
    selector: { type: String },
  },
  { _id: false }
);

const LatticeOutputSchema = new Schema<ILatticeOutput>(
  {
    targetEntityId: { type: String, required: true },
    targetAttribute: { type: String, required: true },
    dataType: {
      type: String,
      enum: ['number', 'currency', 'percentage', 'string', 'boolean', 'date', 'datetime'],
      default: 'number',
    },
  },
  { _id: false }
);

const LatticeConditionSchema = new Schema<ILatticeCondition>(
  {
    left: LatticeInputSchema,
    operator: {
      type: String,
      enum: ['==', '!=', '>', '<', '>=', '<=', 'contains', 'in'],
      required: true,
    },
    right: LatticeInputSchema,
    logicalJoin: { type: String, enum: ['AND', 'OR'] },
  },
  { _id: false }
);

const LatticeRuleDefinitionSchema = new Schema<ILatticeRuleDefinition>(
  {
    operation: {
      type: String,
      enum: [
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
        'SUM',
        'AVERAGE',
        'MIN',
        'MAX',
        'COUNT',
        'MEDIAN',
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
        'PERCENT_OF',
        'GROWTH_RATE',
        'NPV',
        'IRR',
        'PMT',
        'FV',
        'PV',
        'REFERENCE',
        'LOOKUP',
      ],
      required: true,
    },
    inputs: [LatticeInputSchema],
    output: LatticeOutputSchema,
    conditions: [LatticeConditionSchema],
  },
  { _id: false }
);

const LatticeRuleSchema = new Schema<ILatticeRule>(
  {
    id: { type: String, required: true },
    name: { type: String, required: true },
    description: { type: String },
    type: {
      type: String,
      enum: ['formula', 'aggregation', 'constraint', 'transformation', 'conditional'],
      required: true,
    },
    definition: LatticeRuleDefinitionSchema,
    dependencies: [{ type: String }],
    priority: { type: Number, default: 0 },
    enabled: { type: Boolean, default: true },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const LatticeRulesetSchema = new Schema<ILatticeRuleset>(
  {
    id: { type: String, required: true },
    name: { type: String, required: true },
    ruleIds: [{ type: String }],
    description: { type: String },
  },
  { _id: false }
);

const LatticeRulesStoreSchema = new Schema(
  {
    rules: [LatticeRuleSchema],
    rulesets: [LatticeRulesetSchema],
  },
  { _id: false }
);

// --- View Layer ---

const LatticeRowConfigSchema = new Schema<ILatticeRowConfig>(
  {
    source: { type: String, enum: ['entity', 'rule', 'category'], required: true },
    ref: { type: String, required: true },
    label: { type: String },
    indent: { type: Number },
    isSummary: { type: Boolean },
  },
  { _id: false }
);

const LatticeColumnConfigSchema = new Schema<ILatticeColumnConfig>(
  {
    source: { type: String, enum: ['period', 'scenario', 'attribute', 'computed'], required: true },
    ref: { type: String, required: true },
    label: { type: String },
    width: { type: Number },
  },
  { _id: false }
);

const LatticeFilterSchema = new Schema<ILatticeFilter>(
  {
    field: { type: String, required: true },
    operator: {
      type: String,
      enum: ['==', '!=', '>', '<', '>=', '<=', 'contains', 'in'],
      required: true,
    },
    value: { type: Schema.Types.Mixed },
  },
  { _id: false }
);

const LatticeSortConfigSchema = new Schema<ILatticeSortConfig>(
  {
    field: { type: String, required: true },
    direction: { type: String, enum: ['asc', 'desc'], default: 'asc' },
  },
  { _id: false }
);

const LatticeGroupConfigSchema = new Schema<ILatticeGroupConfig>(
  {
    groupBy: [{ type: String }],
    aggregation: { type: String },
  },
  { _id: false }
);

const LatticeFormatConfigSchema = new Schema<ILatticeFormatConfig>(
  {
    numberFormat: { type: String },
    currencySymbol: { type: String },
    percentageDecimals: { type: Number },
    negativeFormat: { type: String, enum: ['parentheses', 'minus', 'red'] },
    showGridLines: { type: Boolean },
    zebra: { type: Boolean },
    compactMode: { type: Boolean },
  },
  { _id: false }
);

const LatticeViewConfigSchema = new Schema<ILatticeViewConfig>(
  {
    rows: [LatticeRowConfigSchema],
    columns: [LatticeColumnConfigSchema],
    filters: [LatticeFilterSchema],
    sorting: [LatticeSortConfigSchema],
    grouping: LatticeGroupConfigSchema,
    formatting: LatticeFormatConfigSchema,
  },
  { _id: false }
);

const LatticeViewSchema = new Schema<ILatticeView>(
  {
    id: { type: String, required: true },
    type: {
      type: String,
      enum: ['table', 'pivot', 'time_series', 'comparison', 'summary_card', 'waterfall', 'tree'],
      required: true,
    },
    name: { type: String, required: true },
    config: LatticeViewConfigSchema,
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const LatticeViewStoreSchema = new Schema(
  {
    views: [LatticeViewSchema],
    activeViewId: { type: String },
  },
  { _id: false }
);

// --- Settings ---

const LatticeModelSettingsSchema = new Schema<ILatticeModelSettings>(
  {
    currency: { type: String, default: 'USD' },
    fiscalYearStart: { type: String, default: '01-01' },
    periodGrain: {
      type: String,
      enum: ['day', 'week', 'month', 'quarter', 'year'],
      default: 'quarter',
    },
    defaultDecimalPlaces: { type: Number, default: 2 },
    negativeFormat: {
      type: String,
      enum: ['parentheses', 'minus', 'red'],
      default: 'parentheses',
    },
  },
  { _id: false }
);

// --- Scenarios ---

const LatticeScenarioOverrideSchema = new Schema<ILatticeScenarioOverride>(
  {
    entityId: { type: String, required: true },
    attributeKey: { type: String, required: true },
    value: { type: Schema.Types.Mixed },
  },
  { _id: false }
);

const LatticeScenarioSchema = new Schema<ILatticeScenario>(
  {
    id: { type: String, required: true },
    name: { type: String, required: true },
    description: { type: String },
    overrides: [LatticeScenarioOverrideSchema],
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

// --- Operations (undo/redo) ---

const LatticeOperationSchema = new Schema<ILatticeOperation>(
  {
    id: { type: String, required: true },
    type: {
      type: String,
      enum: [
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
      ],
      required: true,
    },
    timestamp: { type: Date, default: Date.now },
    data: { type: Schema.Types.Mixed },
    inverse: { type: Schema.Types.Mixed },
    description: { type: String },
    messageId: { type: String },
  },
  { _id: false }
);

// MAIN SCHEMA

const LatticeModelSchema = new Schema<ILatticeModelDocument, ILatticeModelModel>(
  {
    // Identity
    name: { type: String, required: true },
    description: { type: String },
    modelType: {
      type: String,
      enum: ['income_statement', 'balance_sheet', 'cashflow', 'saas_metrics', 'dcf', 'lbo', 'custom'],
      default: 'custom',
    },

    // Ownership
    userId: { type: String, required: true, index: true },
    sessionId: { type: String, index: true },
    projectId: { type: String, index: true },
    organizationId: { type: String, index: true },

    // Core Data Layers
    data: { type: LatticeDataStoreSchema, default: () => ({ entities: [], relationships: [] }) },
    rules: { type: LatticeRulesStoreSchema, default: () => ({ rules: [], rulesets: [] }) },
    views: { type: LatticeViewStoreSchema, default: () => ({ views: [] }) },

    // Settings
    settings: {
      type: LatticeModelSettingsSchema,
      default: () => ({
        currency: 'USD',
        fiscalYearStart: '01-01',
        periodGrain: 'quarter',
        defaultDecimalPlaces: 2,
        negativeFormat: 'parentheses',
      }),
    },

    // Scenarios
    scenarios: [LatticeScenarioSchema],
    activeScenarioId: { type: String },

    // History
    operations: [LatticeOperationSchema],
    operationIndex: { type: Number, default: -1 },

    // Versioning
    version: { type: Number, default: 1 },
    contentHash: { type: String },

    // Computation tracking
    lastComputedAt: { type: Date },

    // Soft delete
    deletedAt: { type: Date },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform: function (_doc, ret: Record<string, unknown>) {
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
    toObject: {
      virtuals: true,
    },
  }
);

// INDEXES

// User + name uniqueness (within non-deleted models)
LatticeModelSchema.index(
  { userId: 1, name: 1 },
  { unique: true, partialFilterExpression: { deletedAt: { $exists: false } } }
);

// Session-based queries
LatticeModelSchema.index({ sessionId: 1, updatedAt: -1 });

// Project-based queries
LatticeModelSchema.index({ projectId: 1, updatedAt: -1 });

// Organization-based queries
LatticeModelSchema.index({ organizationId: 1, updatedAt: -1 });

// Text search
LatticeModelSchema.index(
  { name: 'text', description: 'text' },
  { weights: { name: 10, description: 5 }, name: 'lattice_model_search_text' }
);

// PLUGINS

LatticeModelSchema.plugin(softDeletePlugin);

// REPOSITORY

export class LatticeModelRepository extends BaseRepository<ILatticeModelDocument> {
  constructor(model: ILatticeModelModel) {
    super(model);
  }

  async findByUserId(userId: string, options?: { limit?: number; skip?: number }) {
    return this.find(
      { userId },
      {
        sort: { updatedAt: -1 },
        limit: options?.limit,
        skip: options?.skip,
      }
    );
  }

  async findBySessionId(sessionId: string) {
    return this.find({ sessionId }, { sort: { updatedAt: -1 } });
  }

  async findByProjectId(projectId: string) {
    return this.find({ projectId }, { sort: { updatedAt: -1 } });
  }

  /**
   * Search models by name/description
   */
  async search(userId: string, query: string, limit = 20) {
    return this.model
      .find({
        userId,
        deletedAt: null,
        $text: { $search: query },
      })
      .sort({ score: { $meta: 'textScore' } })
      .limit(limit)
      .lean();
  }

  /**
   * Update model version atomically
   */
  async incrementVersion(modelId: string) {
    return this.model.findByIdAndUpdate(modelId, { $inc: { version: 1 }, updatedAt: new Date() }, { new: true });
  }
}

// MODEL EXPORT

export const LatticeModel =
  (mongoose.models.LatticeModel as ILatticeModelModel) ||
  mongoose.model<ILatticeModelDocument, ILatticeModelModel>('LatticeModel', LatticeModelSchema);

export const latticeModelRepository = new LatticeModelRepository(LatticeModel);
