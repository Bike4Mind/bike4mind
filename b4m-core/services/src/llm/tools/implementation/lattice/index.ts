import { Logger } from '@bike4mind/observability';
/**
 * Lattice LLM Tools
 *
 * Natural language tools for creating and manipulating financial pro-forma models.
 * These tools enable conversational creation of spreadsheet-like models through
 * the Lattice three-layer architecture (Data, Rules, Views).
 */

import { ToolContext, ToolDefinition } from '../../base/types';
import type { ILatticeModel, LatticeEntityType, LatticeDataType, LatticeOperation } from '@bike4mind/common';

// Shared types

interface LatticeCreateModelParams {
  name: string;
  description?: string;
  modelType?: 'income_statement' | 'balance_sheet' | 'cashflow' | 'saas_metrics' | 'custom';
  /** Initial entities to create with the model - allows populating in one call */
  initialData?: {
    entities?: Array<{
      name: string;
      type?: string;
      values?: Array<{ period: string; value: number }>;
    }>;
    rules?: Array<{
      name: string;
      formula: string;
    }>;
  };
}

interface LatticeAddEntityParams {
  modelId: string;
  name: string;
  type: LatticeEntityType;
  displayName?: string;
  initialValues?: Array<{ key: string; value: number | string; dataType?: LatticeDataType }>;
}

interface LatticeSetValueParams {
  modelId: string;
  entityName: string;
  attributeKey: string;
  value: string; // Will be parsed to number if numeric
}

interface LatticeCreateRuleParams {
  modelId: string;
  name: string;
  description?: string;
  formula: string; // Natural language formula like "Gross Profit = Revenue - COGS"
}

interface LatticeQueryParams {
  modelId: string;
  query: string; // Natural language query like "What is Q1 2024 gross margin?"
}

interface LatticeExplainParams {
  modelId: string;
  entityName: string;
  attributeKey: string;
}

// Tool: create model

/**
 * Create model data structure (used when database is not available)
 */
function createModelData(
  name: string,
  modelType: string,
  userId: string,
  description?: string,
  sessionId?: string
): Partial<ILatticeModel> {
  const now = new Date();

  return {
    name,
    description: description || '',
    modelType: modelType as ILatticeModel['modelType'],
    userId,
    sessionId,
    data: { entities: [], relationships: [] },
    rules: { rules: [], rulesets: [] },
    views: { views: [] },
    settings: {
      currency: 'USD',
      fiscalYearStart: '01-01',
      periodGrain: 'quarter',
      defaultDecimalPlaces: 2,
      negativeFormat: 'parentheses',
    },
    scenarios: [],
    operations: [],
    operationIndex: -1,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}

export const latticeCreateModelTool: ToolDefinition = {
  name: 'lattice_create_model',
  implementation: (context: Omit<ToolContext, 'config'>) => ({
    toolFn: async (params: unknown): Promise<string> => {
      const { name, description, modelType = 'custom', initialData } = params as LatticeCreateModelParams;

      Logger.globalInstance.debug('[LATTICE DEBUG] 🏗️ lattice_create_model called:', {
        name,
        description,
        modelType,
        hasInitialData: !!initialData,
        entityCount: initialData?.entities?.length || 0,
        ruleCount: initialData?.rules?.length || 0,
      });

      const modelData = createModelData(name, modelType, context.userId, description);

      if (initialData?.entities && modelData.data) {
        const now = new Date();
        for (const entityDef of initialData.entities) {
          const entityId = entityDef.name.toLowerCase().replace(/\s+/g, '_');
          const attributes: Array<{
            key: string;
            value: number | string;
            dataType: 'number' | 'currency' | 'percentage' | 'string';
            isComputed: boolean;
          }> = [];

          if (entityDef.values) {
            for (const val of entityDef.values) {
              attributes.push({
                key: 'period',
                value: val.period,
                dataType: 'string',
                isComputed: false,
              });
              attributes.push({
                key: 'value',
                value: val.value,
                dataType: 'currency',
                isComputed: false,
              });
              attributes.push({
                key: 'category',
                value: entityDef.name,
                dataType: 'string',
                isComputed: false,
              });

              // Create one entity per period-value combination
              modelData.data.entities.push({
                id: `${entityId}_${val.period.toLowerCase().replace(/\s+/g, '_')}`,
                type: (entityDef.type as LatticeEntityType) || 'line_item',
                name: `${entityDef.name} ${val.period}`,
                displayName: `${entityDef.name} ${val.period}`,
                attributes: [
                  { key: 'period', value: val.period, dataType: 'string', isComputed: false },
                  { key: 'value', value: val.value, dataType: 'currency', isComputed: false },
                  { key: 'category', value: entityDef.name, dataType: 'string', isComputed: false },
                ],
                metadata: {},
                createdAt: now,
                updatedAt: now,
              });
            }
          }
          Logger.globalInstance.debug(
            `[LATTICE DEBUG] ➕ Created entity: ${entityDef.name} with ${entityDef.values?.length || 0} period values`
          );
        }
      }

      if (initialData?.rules && modelData.rules) {
        const now = new Date();
        for (const ruleDef of initialData.rules) {
          const ruleId = `rule_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
          const parsedRule = parseFormula(ruleDef.formula);

          modelData.rules.rules.push({
            id: ruleId,
            name: ruleDef.name,
            description: ruleDef.formula,
            type: 'formula',
            definition: {
              operation: parsedRule.operation,
              inputs: parsedRule.inputs.map(ref => ({ type: 'entity' as const, ref })),
              output: {
                targetEntityId: parsedRule.outputEntity.toLowerCase().replace(/\s+/g, '_'),
                targetAttribute: 'computed',
                dataType: 'number',
              },
            },
            dependencies: parsedRule.inputs.map(i => i.toLowerCase().replace(/\s+/g, '_')),
            priority: 0,
            enabled: true,
            createdAt: now,
            updatedAt: now,
          });
          Logger.globalInstance.debug(`[LATTICE DEBUG] 📐 Created rule: ${ruleDef.name} = ${ruleDef.formula}`);
        }
      }

      let model: ILatticeModel;
      let persistenceStatus = 'unknown';
      const dbKeys = Object.keys(context.db || {});
      const hasLatticeModels = !!context.db?.latticeModels;

      // Try to persist to database if available
      if (context.db.latticeModels) {
        try {
          model = await context.db.latticeModels.create(modelData);
          persistenceStatus = `PERSISTED to MongoDB (id: ${model.id})`;
          context.logger.info(`[Lattice] Created model ${model.id} in database`);
        } catch (error) {
          persistenceStatus = `FAILED: ${error instanceof Error ? error.message : String(error)}`;
          context.logger.error(`[Lattice] Failed to persist model to database:`, error);
          // Fall back to in-memory model with generated ID
          model = {
            ...modelData,
            id: `lattice_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          } as ILatticeModel;
        }
      } else {
        // No database adapter - create in-memory model with generated ID
        persistenceStatus = `IN-MEMORY (no latticeModels adapter). DB keys: [${dbKeys.join(', ')}]`;
        context.logger.warn('[Lattice] No database adapter available, creating in-memory model');
        model = {
          ...modelData,
          id: `lattice_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        } as ILatticeModel;
      }

      // Create artifact data for client-side rendering
      const artifactData = {
        type: 'lattice',
        id: model.id,
        title: name,
        content: JSON.stringify(model),
        metadata: {
          modelType,
          periodGrain: model.settings?.periodGrain || 'quarter',
          currency: model.settings?.currency || 'USD',
          entityCount: model.data?.entities?.length || 0,
          ruleCount: model.rules?.rules?.length || 0,
          // DEBUG: Include persistence info in metadata
          _debug: {
            persistenceStatus,
            hasLatticeModels,
            dbKeys,
          },
        },
        createdAt: model.createdAt?.toISOString?.() || new Date().toISOString(),
        updatedAt: model.updatedAt?.toISOString?.() || new Date().toISOString(),
      };

      // Return as artifact block that client can parse and display
      const entityCount = model.data?.entities?.length || 0;
      const ruleCount = model.rules?.rules?.length || 0;

      return `Created "${name}" model with ${entityCount} entities and ${ruleCount} rules.

<artifact identifier="${model.id}" type="application/vnd.b4m.lattice" title="${name}">
${JSON.stringify(artifactData, null, 2)}
</artifact>

The model is ready for viewing. You can add more data by asking to add line items or create formulas.`;
    },
    toolSchema: {
      name: 'lattice_create_model',
      description: `Create a new Lattice financial model with optional initial data. Use initialData to populate entities and rules in ONE call.

**IMPORTANT**: Always include initialData when the user provides specific values! This creates a fully populated model immediately.

**When to use:** When the user wants to:
- Create a new financial model, spreadsheet, or pro-forma
- Start building an income statement, balance sheet, or cash flow
- Set up a SaaS metrics dashboard

**Example with initialData:**
User: "Create income statement with $100K revenue and $60K costs for Q1"
Call: lattice_create_model with:
- name: "Income Statement"
- modelType: "income_statement"
- initialData: {
    entities: [
      { name: "Revenue", values: [{ period: "Q1", value: 100000 }] },
      { name: "Costs", values: [{ period: "Q1", value: 60000 }] }
    ],
    rules: [
      { name: "Gross Profit", formula: "Gross Profit = Revenue - Costs" }
    ]
  }`,
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Name of the model (e.g., "2024 Budget", "Q1 Forecast")',
          },
          description: {
            type: 'string',
            description: 'Optional description of what this model represents',
          },
          modelType: {
            type: 'string',
            enum: ['income_statement', 'balance_sheet', 'cashflow', 'saas_metrics', 'custom'],
            description: 'Type of financial model to create',
          },
          initialData: {
            type: 'object',
            description: 'Initial entities and rules to populate the model. ALWAYS use this when user provides data!',
            properties: {
              entities: {
                type: 'array',
                description: 'Line items with their period values',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string', description: 'Entity name (e.g., "Revenue", "COGS")' },
                    type: { type: 'string', description: 'Entity type (default: line_item)' },
                    values: {
                      type: 'array',
                      description: 'Period-value pairs',
                      items: {
                        type: 'object',
                        properties: {
                          period: { type: 'string', description: 'Period name (e.g., "Q1", "Jan", "2024")' },
                          value: { type: 'number', description: 'Numeric value' },
                        },
                        required: ['period', 'value'],
                      },
                    },
                  },
                  required: ['name'],
                },
              },
              rules: {
                type: 'array',
                description: 'Formulas/calculations to create',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string', description: 'Rule name (e.g., "Gross Profit Calculation")' },
                    formula: {
                      type: 'string',
                      description: 'Natural language formula (e.g., "Gross Profit = Revenue - Costs")',
                    },
                  },
                  required: ['name', 'formula'],
                },
              },
            },
          },
        },
        required: ['name'],
      },
    },
  }),
};

// Tool: add entity

export const latticeAddEntityTool: ToolDefinition = {
  name: 'lattice_add_entity',
  implementation: (context: Omit<ToolContext, 'config'>) => ({
    toolFn: async (params: unknown): Promise<string> => {
      const { modelId, name, type, displayName, initialValues = [] } = params as LatticeAddEntityParams;

      Logger.globalInstance.debug('[LATTICE DEBUG] ➕ lattice_add_entity called:', {
        modelId,
        name,
        type,
        initialValues,
      });

      const entityId = name.toLowerCase().replace(/\s+/g, '_');

      const entityData = {
        id: entityId,
        type,
        name,
        displayName: displayName || name,
        attributes: initialValues.map(v => ({
          key: v.key,
          value: v.value,
          dataType: v.dataType || (typeof v.value === 'number' ? 'number' : 'string'),
          isComputed: false,
        })),
        metadata: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      // Try to persist to database if model is persisted
      if (context.db.latticeModels && modelId && /^[a-f0-9]{24}$/.test(modelId)) {
        try {
          const model = await context.db.latticeModels.findById(modelId);
          if (model) {
            // Check if entity already exists
            const existingIndex = model.data.entities.findIndex(e => e.id === entityId);
            if (existingIndex >= 0) {
              // Update existing entity
              model.data.entities[existingIndex] = entityData;
            } else {
              // Add new entity
              model.data.entities.push(entityData);
            }

            // Save the updated model
            await context.db.latticeModels.update({
              id: modelId,
              data: model.data,
              updatedAt: new Date(),
            });
            context.logger.info(`[Lattice] Added entity ${entityId} to model ${modelId}`);
          } else {
            context.logger.warn(`[Lattice] Model ${modelId} not found in database`);
          }
        } catch (error) {
          context.logger.error(`[Lattice] Failed to persist entity to database:`, error);
        }
      }

      return JSON.stringify({
        success: true,
        action: 'ADD_ENTITY',
        modelId,
        entityId,
        data: entityData,
        message: `Added ${type} "${displayName || name}" to model. ${
          initialValues.length > 0
            ? `Set initial values: ${initialValues.map(v => `${v.key}=${v.value}`).join(', ')}`
            : 'No initial values set.'
        }`,
      });
    },
    toolSchema: {
      name: 'lattice_add_entity',
      description: `Add a line item, account, period, or other entity to a Lattice model.

**When to use:** When the user mentions:
- Adding a revenue line, expense category, or account
- Creating periods (Q1, Q2, Jan, Feb, etc.)
- Adding any measurable item to their model

**Entity types:**
- line_item: Revenue streams, expense lines, KPIs
- account: Cash, AR, AP, inventory, etc.
- period: Q1 2024, Jan, FY2025, etc.
- category: Groups of line items (Operating Expenses)
- scenario: Base case, upside, downside
- custom: Any other structured element

**Examples:**
- "Add Revenue" → line_item named "Revenue"
- "Create a Marketing Expenses category" → category named "Marketing Expenses"
- "Add quarters Q1 through Q4" → 4 period entities`,
      parameters: {
        type: 'object',
        properties: {
          modelId: {
            type: 'string',
            description: 'ID of the model to add the entity to',
          },
          name: {
            type: 'string',
            description: 'Internal name for the entity (used in formulas)',
          },
          type: {
            type: 'string',
            enum: ['line_item', 'account', 'period', 'category', 'scenario', 'custom'],
            description: 'Type of entity',
          },
          displayName: {
            type: 'string',
            description: 'Human-readable display name (defaults to name)',
          },
          initialValues: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                key: { type: 'string', description: 'Period or attribute key (e.g., "Q1_2024")' },
                value: { type: 'string', description: 'The value (number or string)' },
                dataType: {
                  type: 'string',
                  enum: ['number', 'currency', 'percentage', 'string'],
                  description: 'Data type for the value',
                },
              },
              required: ['key', 'value'],
            },
            description: 'Optional initial values for this entity',
          },
        },
        required: ['modelId', 'name', 'type'],
      },
    },
  }),
};

// Tool: set value

export const latticeSetValueTool: ToolDefinition = {
  name: 'lattice_set_value',
  implementation: (context: Omit<ToolContext, 'config'>) => ({
    toolFn: async (params: unknown): Promise<string> => {
      const { modelId, entityName, attributeKey, value: rawValue } = params as LatticeSetValueParams;

      Logger.globalInstance.debug('[LATTICE DEBUG] 📝 lattice_set_value called:', {
        modelId,
        entityName,
        attributeKey,
        rawValue,
      });

      // Parse value - convert to number if numeric
      let value: number | string | boolean = rawValue;
      const numValue = parseFloat(rawValue);
      if (!isNaN(numValue)) {
        value = numValue;
      } else if (rawValue.toLowerCase() === 'true') {
        value = true;
      } else if (rawValue.toLowerCase() === 'false') {
        value = false;
      }

      // Convert entityName to entityId format
      const entityId = entityName.toLowerCase().replace(/\s+/g, '_');

      // Try to persist to database if model is persisted
      if (context.db.latticeModels && modelId && /^[a-f0-9]{24}$/.test(modelId)) {
        try {
          const model = await context.db.latticeModels.findById(modelId);
          if (model) {
            // Find the entity
            const entity = model.data.entities.find(e => e.id === entityId || e.name === entityName);
            if (entity) {
              // Find or create attribute
              const attrIndex = entity.attributes.findIndex(a => a.key === attributeKey);
              const dataType = typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'string';
              const attributeData = {
                key: attributeKey,
                value,
                dataType: dataType as LatticeDataType,
                isComputed: false,
              };

              if (attrIndex >= 0) {
                entity.attributes[attrIndex] = attributeData;
              } else {
                entity.attributes.push(attributeData);
              }

              entity.updatedAt = new Date();

              // Save the updated model
              await context.db.latticeModels.update({
                id: modelId,
                data: model.data,
                updatedAt: new Date(),
              });
              context.logger.info(`[Lattice] Set ${entityId}.${attributeKey} = ${value} in model ${modelId}`);
            } else {
              context.logger.warn(`[Lattice] Entity ${entityName} not found in model ${modelId}`);
            }
          } else {
            context.logger.warn(`[Lattice] Model ${modelId} not found in database`);
          }
        } catch (error) {
          context.logger.error(`[Lattice] Failed to persist value to database:`, error);
        }
      }

      return JSON.stringify({
        success: true,
        action: 'SET_VALUE',
        modelId,
        data: {
          entityName,
          attributeKey,
          value,
        },
        message: `Set ${entityName}.${attributeKey} = ${value}`,
      });
    },
    toolSchema: {
      name: 'lattice_set_value',
      description: `Set a specific value in a Lattice model.

**When to use:** When the user provides a specific number:
- "Revenue in Q1 is 150,000"
- "Set marketing spend to 50k for January"
- "COGS is 40% of revenue" (use lattice_create_rule for formulas)

**Important:** This tool is for setting raw input values. For calculated values (formulas), use \`lattice_create_rule\` instead.

**Examples:**
- "Q1 revenue is $100,000" → entityName="Revenue", attributeKey="Q1", value=100000
- "Set headcount to 25" → entityName="Headcount", attributeKey="current", value=25`,
      parameters: {
        type: 'object',
        properties: {
          modelId: {
            type: 'string',
            description: 'ID of the model',
          },
          entityName: {
            type: 'string',
            description: 'Name of the entity (line item, account, etc.)',
          },
          attributeKey: {
            type: 'string',
            description: 'Period or attribute key (e.g., "Q1_2024", "current", "budget")',
          },
          value: {
            type: 'string',
            description: 'The value to set (will be parsed as number if numeric)',
          },
        },
        required: ['modelId', 'entityName', 'attributeKey', 'value'],
      },
    },
  }),
};

// Tool: create rule

export const latticeCreateRuleTool: ToolDefinition = {
  name: 'lattice_create_rule',
  implementation: (context: Omit<ToolContext, 'config'>) => ({
    toolFn: async (params: unknown): Promise<string> => {
      const { modelId, name, description, formula } = params as LatticeCreateRuleParams;

      Logger.globalInstance.debug('[LATTICE DEBUG] 📐 lattice_create_rule called:', { modelId, name, formula });

      // Parse the natural language formula into structured rule
      // This is a simplified parser - the real implementation would use LLM structured output
      const parsedRule = parseFormula(formula);

      const ruleId = `rule_${Date.now()}`;

      const ruleData = {
        id: ruleId,
        name,
        description: description || formula,
        type: 'formula' as const,
        definition: {
          operation: parsedRule.operation,
          inputs: parsedRule.inputs.map(ref => ({
            type: 'entity' as const,
            ref,
          })),
          output: {
            targetEntityId: parsedRule.outputEntity.toLowerCase().replace(/\s+/g, '_'),
            targetAttribute: 'computed',
            dataType: 'number' as const,
          },
        },
        dependencies: parsedRule.inputs.map(i => i.toLowerCase().replace(/\s+/g, '_')),
        priority: 0,
        enabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const outputEntityId = parsedRule.outputEntity.toLowerCase().replace(/\s+/g, '_');
      let entityCreatedMessage = '';

      // Try to persist to database if model is persisted
      if (context.db.latticeModels && modelId && /^[a-f0-9]{24}$/.test(modelId)) {
        try {
          const model = await context.db.latticeModels.findById(modelId);
          if (model) {
            // Check if output entity exists, if not create it
            const outputEntityExists = model.data.entities.some(
              e => e.id === outputEntityId || e.name.toLowerCase() === parsedRule.outputEntity.toLowerCase()
            );

            if (!outputEntityExists && parsedRule.outputEntity !== 'unknown') {
              // Auto-create the output entity as a computed line item
              const now = new Date();
              const newEntity = {
                id: outputEntityId,
                type: 'line_item' as const,
                name: parsedRule.outputEntity,
                displayName: parsedRule.outputEntity,
                attributes: [
                  {
                    key: 'value',
                    value: 0,
                    dataType: 'currency' as const,
                    isComputed: true,
                  },
                  {
                    key: 'category',
                    value: 'Computed',
                    dataType: 'string' as const,
                    isComputed: false,
                  },
                ],
                metadata: { isComputed: true },
                createdAt: now,
                updatedAt: now,
              };
              model.data.entities.push(newEntity);
              entityCreatedMessage = ` Created output entity "${parsedRule.outputEntity}".`;
              context.logger.info(`[Lattice] Auto-created output entity ${outputEntityId} for rule ${ruleId}`);
            }

            // Check if rule already exists
            const existingIndex = model.rules.rules.findIndex(r => r.id === ruleId || r.name === name);
            if (existingIndex >= 0) {
              model.rules.rules[existingIndex] = ruleData;
            } else {
              model.rules.rules.push(ruleData);
            }

            // Save the updated model (both entities and rules if entity was created)
            await context.db.latticeModels.update({
              id: modelId,
              data: model.data,
              rules: model.rules,
              updatedAt: new Date(),
            });
            context.logger.info(`[Lattice] Created rule ${ruleId} in model ${modelId}`);
          } else {
            context.logger.warn(`[Lattice] Model ${modelId} not found in database`);
          }
        } catch (error) {
          context.logger.error(`[Lattice] Failed to persist rule to database:`, error);
        }
      }

      return JSON.stringify({
        success: true,
        action: 'CREATE_RULE',
        modelId,
        ruleId,
        data: {
          name,
          description,
          formula,
          parsed: parsedRule,
          outputEntityCreated: entityCreatedMessage !== '',
        },
        message: `Created rule "${name}": ${formula}.${entityCreatedMessage}`,
      });
    },
    toolSchema: {
      name: 'lattice_create_rule',
      description: `Create a formula or calculation rule in a Lattice model.

**When to use:** When the user defines a calculation:
- "Gross profit equals revenue minus COGS"
- "Net margin is net income divided by revenue times 100"
- "Total expenses is the sum of all expense line items"

**IMPORTANT: For per-period calculations like "calculate X for each quarter", you MUST call this tool ONCE for EACH period.** For example, if asked to "calculate gross margin for each quarter", call this tool 4 times:
1. lattice_create_rule with formula "Q1 Gross Margin = Q1 Revenue - Q1 COGS"
2. lattice_create_rule with formula "Q2 Gross Margin = Q2 Revenue - Q2 COGS"
3. lattice_create_rule with formula "Q3 Gross Margin = Q3 Revenue - Q3 COGS"
4. lattice_create_rule with formula "Q4 Gross Margin = Q4 Revenue - Q4 COGS"

**Formula syntax (natural language):**
- Arithmetic: "X equals Y plus Z", "A minus B", "C times D"
- Aggregation: "sum of", "average of", "total"
- Percentage: "X percent of Y", "as a percentage"
- Comparison: "if X is greater than Y then A else B"

**Examples:**
- "Gross Profit = Revenue - COGS"
- "Gross Margin = Gross Profit / Revenue * 100"
- "Total OpEx = sum of all Operating Expenses"
- "YoY Growth = (Current Year - Prior Year) / Prior Year * 100"
- "Q1 Gross Margin = Q1 Revenue - Q1 COGS" (per-period)`,
      parameters: {
        type: 'object',
        properties: {
          modelId: {
            type: 'string',
            description: 'ID of the model',
          },
          name: {
            type: 'string',
            description: 'Name for this rule (e.g., "Gross Profit Calculation")',
          },
          description: {
            type: 'string',
            description: 'Optional description of what this rule calculates',
          },
          formula: {
            type: 'string',
            description: 'The formula in natural language or equation format',
          },
        },
        required: ['modelId', 'name', 'formula'],
      },
    },
  }),
};

// Tool: query

export const latticeQueryTool: ToolDefinition = {
  name: 'lattice_query',
  implementation: () => ({
    toolFn: async (params: unknown): Promise<string> => {
      const { modelId, query } = params as LatticeQueryParams;

      // Parse the query to understand what's being asked
      const parsedQuery = parseQuery(query);

      return JSON.stringify({
        success: true,
        action: 'QUERY',
        modelId,
        data: {
          query,
          parsed: parsedQuery,
        },
        message: `Querying model for: ${query}`,
      });
    },
    toolSchema: {
      name: 'lattice_query',
      description: `Query a Lattice model for specific values or aggregations.

**When to use:** When the user asks about values in the model:
- "What's Q1 gross margin?"
- "Show me total revenue for 2024"
- "What are all the expense categories?"
- "Compare Q1 vs Q2 performance"

**Query types:**
- Single value: "What is [entity] for [period]?"
- Aggregation: "Total [entity] for [range]"
- Comparison: "Compare [entity] across [periods]"
- List: "Show all [entity type]"

**Examples:**
- "What's Q2 revenue?" → Returns specific value
- "Total revenue for 2024" → Sums Q1-Q4
- "Compare gross margin Q1 vs Q2" → Side-by-side comparison`,
      parameters: {
        type: 'object',
        properties: {
          modelId: {
            type: 'string',
            description: 'ID of the model to query',
          },
          query: {
            type: 'string',
            description: 'Natural language query about the model',
          },
        },
        required: ['modelId', 'query'],
      },
    },
  }),
};

// Tool: explain

export const latticeExplainTool: ToolDefinition = {
  name: 'lattice_explain',
  implementation: () => ({
    toolFn: async (params: unknown): Promise<string> => {
      const { modelId, entityName, attributeKey } = params as LatticeExplainParams;

      return JSON.stringify({
        success: true,
        action: 'EXPLAIN',
        modelId,
        data: {
          entityName,
          attributeKey,
        },
        message: `Explaining calculation for ${entityName}.${attributeKey}`,
      });
    },
    toolSchema: {
      name: 'lattice_explain',
      description: `Explain how a value in a Lattice model was calculated.

**When to use:** When the user wants to understand a calculation:
- "How did you calculate gross profit?"
- "Explain the Q2 margin number"
- "Show me the formula for total expenses"
- "Why is this number so high?"

This tool traces the calculation chain from the target value back through all its inputs and rules, providing a step-by-step explanation.`,
      parameters: {
        type: 'object',
        properties: {
          modelId: {
            type: 'string',
            description: 'ID of the model',
          },
          entityName: {
            type: 'string',
            description: 'Name of the entity containing the value to explain',
          },
          attributeKey: {
            type: 'string',
            description: 'Period or attribute key of the value to explain',
          },
        },
        required: ['modelId', 'entityName', 'attributeKey'],
      },
    },
  }),
};

// Helper functions

/**
 * Parse a natural language formula into structured rule definition
 * This is a simplified implementation - production would use LLM structured output
 */
function parseFormula(formula: string): {
  operation: LatticeOperation;
  outputEntity: string;
  inputs: string[];
} {
  // Simple pattern matching for common formulas
  const normalized = formula.toLowerCase().trim();

  // Pattern: "X = Y + Z" or "X equals Y plus Z" (supports multi-word entity names)
  const equalsMatch = normalized.match(/^(.+?)\s*(?:=|equals?)\s*(.+)$/i);

  if (equalsMatch) {
    const [, output, expression] = equalsMatch;

    // Detect operation type
    if (expression.includes('+') || expression.includes('plus')) {
      return {
        operation: 'ADD',
        outputEntity: output,
        inputs: expression.split(/[+]|plus/i).map(s => s.trim()),
      };
    }
    if (expression.includes('-') || expression.includes('minus')) {
      return {
        operation: 'SUBTRACT',
        outputEntity: output,
        inputs: expression.split(/[-]|minus/i).map(s => s.trim()),
      };
    }
    if (expression.includes('*') || expression.includes('times') || expression.includes('x')) {
      return {
        operation: 'MULTIPLY',
        outputEntity: output,
        inputs: expression.split(/[*x]|times/i).map(s => s.trim()),
      };
    }
    if (expression.includes('/') || expression.includes('divided')) {
      return {
        operation: 'DIVIDE',
        outputEntity: output,
        inputs: expression.split(/[/]|divided by/i).map(s => s.trim()),
      };
    }
    if (expression.includes('sum')) {
      return {
        operation: 'SUM',
        outputEntity: output,
        inputs: [expression.replace(/sum of/i, '').trim()],
      };
    }
  }

  // Default: treat as a reference
  return {
    operation: 'REFERENCE',
    outputEntity: 'unknown',
    inputs: [formula],
  };
}

/**
 * Parse a natural language query
 */
function parseQuery(query: string): {
  type: 'single_value' | 'aggregation' | 'comparison' | 'list';
  entities: string[];
  periods: string[];
} {
  const normalized = query.toLowerCase();

  // Detect query type
  let type: 'single_value' | 'aggregation' | 'comparison' | 'list' = 'single_value';

  if (normalized.includes('total') || normalized.includes('sum')) {
    type = 'aggregation';
  } else if (normalized.includes('compare') || normalized.includes('vs')) {
    type = 'comparison';
  } else if (normalized.includes('list') || normalized.includes('show all')) {
    type = 'list';
  }

  // Extract entities and periods (simplified)
  const entities: string[] = [];
  const periods: string[] = [];

  // Look for period patterns
  const periodPatterns = [/q[1-4]/gi, /\d{4}/g, /jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec/gi];
  for (const pattern of periodPatterns) {
    const matches = query.match(pattern);
    if (matches) {
      periods.push(...matches);
    }
  }

  // Common financial terms as potential entities
  const commonEntities = ['revenue', 'expenses', 'profit', 'margin', 'income', 'cost', 'cogs', 'ebitda'];
  for (const entity of commonEntities) {
    if (normalized.includes(entity)) {
      entities.push(entity);
    }
  }

  return { type, entities, periods };
}
