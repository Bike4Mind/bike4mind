/**
 * useLatticeLocalDev - Local Development Hook for Lattice
 *
 * Enables full NLP->Rule testing locally by:
 * 1. Sending messages to /api/lattice/chat
 * 2. Executing tool calls against the Zustand store
 * 3. Running client-side hydration to compute values
 *
 * This bypasses EventBridge for fast local development iteration.
 */

import { useCallback, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { useLattice } from './useLattice';
import type {
  ILatticeModel,
  ILatticeComputedValues,
  LatticeEntityType,
  LatticeDataType,
  LatticeOperation,
  PrimitiveValue,
} from '@bike4mind/common';

// TYPES

interface LatticeToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface LatticeChatResponse {
  success: boolean;
  assistantMessage: string;
  toolCalls: LatticeToolCall[];
  stopReason: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface LatticeLocalDevState {
  isProcessing: boolean;
  lastError: string | null;
  conversationHistory: ConversationMessage[];
  toolResults: Array<{
    toolName: string;
    success: boolean;
    message: string;
  }>;
}

// ENTITY RESOLUTION HELPERS

interface EntityMatch {
  entityId: string;
  period: string | null;
  value: number | null;
}

/**
 * Find entities matching a reference by name, ID, or category
 * Returns matches grouped by period for per-period calculations
 */
function findMatchingEntities(model: ILatticeModel, reference: string): EntityMatch[] {
  const normalizedRef = reference.toLowerCase().trim();
  const matches: EntityMatch[] = [];

  for (const entity of model.data.entities) {
    const nameMatch = entity.name.toLowerCase().includes(normalizedRef);
    const idMatch = entity.id.toLowerCase().includes(normalizedRef);
    const categoryAttr = entity.attributes.find(a => a.key === 'category');
    const categoryMatch =
      categoryAttr &&
      typeof categoryAttr.value === 'string' &&
      categoryAttr.value.toLowerCase().includes(normalizedRef);

    if (nameMatch || idMatch || categoryMatch) {
      const periodAttr = entity.attributes.find(a => a.key === 'period');
      const valueAttr = entity.attributes.find(a => a.key === 'value');

      matches.push({
        entityId: entity.id,
        period: periodAttr && typeof periodAttr.value === 'string' ? periodAttr.value : null,
        value: valueAttr && typeof valueAttr.value === 'number' ? valueAttr.value : null,
      });
    }
  }

  return matches;
}

/**
 * Extract period identifier from period string (e.g., "Q1 2026" -> "Q1")
 */
function extractPeriodKey(period: string | null): string | null {
  if (!period) return null;
  const match = period.match(/Q[1-4]/i);
  return match ? match[0].toUpperCase() : null;
}

// FORMULA PARSER (matches server-side implementation)

function parseFormula(formula: string): {
  operation: LatticeOperation;
  outputEntity: string;
  inputs: string[];
} {
  const normalized = formula.toLowerCase().trim();

  // Pattern: "X = Y + Z" or "X equals Y plus Z" (supports multi-word entity names)
  const equalsMatch = normalized.match(/^(.+?)\s*(?:=|equals?)\s*(.+)$/i);

  if (equalsMatch) {
    const [, output, expression] = equalsMatch;

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

  return {
    operation: 'REFERENCE',
    outputEntity: 'unknown',
    inputs: [formula],
  };
}

// HYDRATION ENGINE (client-side, simplified)

function hydrateModel(model: ILatticeModel): Record<string, Record<string, PrimitiveValue>> {
  const computedValues: Record<string, Record<string, PrimitiveValue>> = {};

  // Initialize with base values
  for (const entity of model.data.entities) {
    computedValues[entity.id] = {};
    for (const attr of entity.attributes) {
      if (!attr.isComputed) {
        // Filter out Date values - convert to ISO string if needed
        const value = attr.value instanceof Date ? attr.value.toISOString() : attr.value;
        computedValues[entity.id][attr.key] = value;
      }
    }
  }

  // Apply rules in order
  for (const rule of model.rules.rules) {
    if (!rule.enabled) continue;

    const { definition } = rule;
    if (!definition) continue;

    // Gather input values
    const inputValues: number[] = [];
    for (const input of definition.inputs) {
      if (input.type === 'literal') {
        const num = parseFloat(input.ref);
        if (!isNaN(num)) inputValues.push(num);
      } else {
        // Parse entity.attribute reference
        const [entityRef, attrKey] = input.selector ? [input.ref, input.selector] : input.ref.split('.');

        const entityId = entityRef.toLowerCase().replace(/\s+/g, '_');
        const entityValues = computedValues[entityId];
        if (entityValues && attrKey in entityValues) {
          const val = entityValues[attrKey];
          if (typeof val === 'number') inputValues.push(val);
        }
      }
    }

    // Apply operation
    let result: number | null = null;
    switch (definition.operation) {
      case 'ADD':
      case 'SUM':
        result = inputValues.reduce((a, b) => a + b, 0);
        break;
      case 'SUBTRACT':
        if (inputValues.length > 0) {
          result = inputValues.slice(1).reduce((a, b) => a - b, inputValues[0]);
        }
        break;
      case 'MULTIPLY':
        result = inputValues.reduce((a, b) => a * b, 1);
        break;
      case 'DIVIDE':
        if (inputValues.length >= 2 && inputValues[1] !== 0) {
          result = inputValues[0] / inputValues[1];
        }
        break;
      case 'AVERAGE':
        if (inputValues.length > 0) {
          result = inputValues.reduce((a, b) => a + b, 0) / inputValues.length;
        }
        break;
      case 'MIN':
        if (inputValues.length > 0) result = Math.min(...inputValues);
        break;
      case 'MAX':
        if (inputValues.length > 0) result = Math.max(...inputValues);
        break;
      case 'PERCENT_OF':
        if (inputValues.length >= 2 && inputValues[1] !== 0) {
          result = (inputValues[0] / inputValues[1]) * 100;
        }
        break;
      case 'GROWTH_RATE':
        if (inputValues.length >= 2 && inputValues[1] !== 0) {
          result = ((inputValues[0] - inputValues[1]) / inputValues[1]) * 100;
        }
        break;
    }

    // Store result
    if (result !== null) {
      const { targetEntityId, targetAttribute } = definition.output;
      if (!computedValues[targetEntityId]) {
        computedValues[targetEntityId] = {};
      }
      computedValues[targetEntityId][targetAttribute] = result;
    }
  }

  return computedValues;
}

// HOOK

export function useLatticeLocalDev() {
  const [state, setState] = useState<LatticeLocalDevState>({
    isProcessing: false,
    lastError: null,
    conversationHistory: [],
    toolResults: [],
  });

  // Get Zustand store actions
  const { model, createModel, addEntity, setEntityValue, addRule, setComputedValues } = useLattice();

  // API mutation
  const chatMutation = useMutation({
    mutationFn: async (params: {
      message: string;
      modelId?: string;
      modelState?: ILatticeModel | null;
      conversationHistory: ConversationMessage[];
    }) => {
      const response = await api.post<LatticeChatResponse>('/api/lattice/chat', params);
      return response.data;
    },
  });

  // Execute a single tool call against the Zustand store
  const executeToolCall = useCallback(
    (toolCall: LatticeToolCall): { success: boolean; message: string; modelId?: string } => {
      const { name, input } = toolCall;

      try {
        switch (name) {
          case 'lattice_create_model': {
            const { name: modelName, modelType = 'custom' } = input as {
              name: string;
              description?: string;
              modelType?: ILatticeModel['modelType'];
            };

            createModel(modelName, modelType);

            // Get the created model ID from the store
            const createdModel = useLattice.getState().model;
            const newModelId = createdModel?.id || 'unknown';

            return {
              success: true,
              message: `Created model "${modelName}" (${modelType})`,
              modelId: newModelId,
            };
          }

          case 'lattice_add_entity': {
            const {
              name: entityName,
              type,
              displayName,
              initialValues = [],
            } = input as {
              modelId: string;
              name: string;
              type: LatticeEntityType;
              displayName?: string;
              initialValues?: Array<{ key: string; value: string | number; dataType?: LatticeDataType }>;
            };

            const entityId = addEntity({
              name: entityName,
              type,
              displayName: displayName || entityName,
              attributes: initialValues.map(v => ({
                key: v.key,
                value: typeof v.value === 'string' ? parseFloat(v.value) || v.value : v.value,
                dataType: v.dataType || (typeof v.value === 'number' ? 'number' : 'string'),
                isComputed: false,
              })),
              metadata: {},
            });

            return {
              success: true,
              message: `Added entity "${entityName}" (${type}) with ID: ${entityId}`,
            };
          }

          case 'lattice_set_value': {
            const {
              entityName,
              attributeKey,
              value: rawValue,
            } = input as {
              modelId: string;
              entityName: string;
              attributeKey: string;
              value: string;
            };

            // Parse value
            let value: number | string | boolean = rawValue;
            const numValue = parseFloat(rawValue);
            if (!isNaN(numValue)) {
              value = numValue;
            } else if (rawValue.toLowerCase() === 'true') {
              value = true;
            } else if (rawValue.toLowerCase() === 'false') {
              value = false;
            }

            // Find entity by name
            const currentModel = useLattice.getState().model;
            const entityId = entityName.toLowerCase().replace(/\s+/g, '_');
            const entity = currentModel?.data.entities.find(e => e.id === entityId || e.name === entityName);

            if (entity) {
              setEntityValue(entity.id, attributeKey, value);
              return {
                success: true,
                message: `Set ${entityName}.${attributeKey} = ${value}`,
              };
            } else {
              return {
                success: false,
                message: `Entity "${entityName}" not found`,
              };
            }
          }

          case 'lattice_create_rule': {
            const {
              name: ruleName,
              description,
              formula,
            } = input as {
              modelId: string;
              name: string;
              description?: string;
              formula: string;
            };

            // Parse formula
            const parsed = parseFormula(formula);
            const currentModel = useLattice.getState().model;

            if (!currentModel) {
              return {
                success: false,
                message: 'No model loaded. Create a model first.',
              };
            }

            // Try to resolve input references to actual entities
            const inputMatches = parsed.inputs.map(ref => ({
              reference: ref,
              matches: findMatchingEntities(currentModel, ref),
            }));

            // Check if we have period-specific matches that need per-period rules
            const allHavePeriods = inputMatches.every(
              im => im.matches.length > 0 && im.matches.every(m => m.period !== null)
            );

            // Group by period if applicable
            const periods = new Set<string>();
            if (allHavePeriods) {
              for (const im of inputMatches) {
                for (const match of im.matches) {
                  const periodKey = extractPeriodKey(match.period);
                  if (periodKey) periods.add(periodKey);
                }
              }
            }

            const createdRules: string[] = [];
            const createdEntities: string[] = [];

            if (periods.size > 1) {
              // Create per-period rules
              for (const periodKey of Array.from(periods).sort()) {
                const periodOutputName = `${periodKey} ${parsed.outputEntity}`;
                const periodOutputId = periodOutputName.toLowerCase().replace(/\s+/g, '_');

                // Find the matching entity for each input for this period
                const periodInputs: string[] = [];
                let allInputsFound = true;

                for (const im of inputMatches) {
                  const periodMatch = im.matches.find(m => extractPeriodKey(m.period) === periodKey);
                  if (periodMatch) {
                    periodInputs.push(periodMatch.entityId);
                  } else {
                    allInputsFound = false;
                    break;
                  }
                }

                if (!allInputsFound) continue;

                // Create output entity if it doesn't exist, or find existing one
                let actualOutputEntityId = periodOutputId;
                const existingEntity = currentModel.data.entities.find(
                  e => e.id === periodOutputId || e.name.toLowerCase() === periodOutputName.toLowerCase()
                );

                if (existingEntity) {
                  actualOutputEntityId = existingEntity.id;
                } else {
                  // Create the entity and capture its actual ID (which is a UUID)
                  actualOutputEntityId = addEntity({
                    name: periodOutputName,
                    type: 'line_item',
                    displayName: periodOutputName,
                    attributes: [
                      { key: 'value', value: 0, dataType: 'currency', isComputed: true },
                      { key: 'period', value: `${periodKey} 2026`, dataType: 'string', isComputed: false },
                      { key: 'category', value: 'Gross Margin', dataType: 'string', isComputed: false },
                    ],
                    metadata: { isComputed: true },
                  });
                  createdEntities.push(periodOutputName);
                }

                // Create the rule using the actual entity ID
                const ruleId = addRule({
                  name: `${periodKey} ${ruleName}`,
                  description: `${periodKey}: ${description || formula}`,
                  type: 'formula',
                  definition: {
                    operation: parsed.operation,
                    inputs: periodInputs.map(entityId => ({
                      type: 'entity' as const,
                      ref: entityId,
                      selector: 'value',
                    })),
                    output: {
                      targetEntityId: actualOutputEntityId,
                      targetAttribute: 'value',
                      dataType: 'number' as const,
                    },
                  },
                  dependencies: periodInputs,
                  priority: 0,
                  enabled: true,
                });

                createdRules.push(`${periodKey} (${ruleId})`);
              }

              const message =
                `Created ${createdRules.length} per-period rules: ${createdRules.join(', ')}.` +
                (createdEntities.length > 0 ? ` Created entities: ${createdEntities.join(', ')}.` : '');

              return {
                success: true,
                message,
              };
            } else {
              // Single rule (no per-period expansion, or single period)
              let actualOutputEntityId = parsed.outputEntity.toLowerCase().replace(/\s+/g, '_');

              // Resolve inputs to actual entity IDs if possible
              const resolvedInputs = parsed.inputs.map(ref => {
                const matches = findMatchingEntities(currentModel, ref);
                if (matches.length === 1) {
                  return matches[0].entityId;
                }
                return ref.toLowerCase().replace(/\s+/g, '_');
              });

              // Try to extract period from input entities (for single-period rules)
              let inferredPeriod: string | null = null;
              if (periods.size === 1) {
                const periodKey = Array.from(periods)[0];
                inferredPeriod = `${periodKey} 2026`;
              }

              // Derive a sensible category from the output entity name
              let inferredCategory = 'Computed';
              const outputLower = parsed.outputEntity.toLowerCase();
              if (outputLower.includes('gross_margin') || outputLower.includes('grossmargin')) {
                inferredCategory = 'Gross Margin';
              } else if (outputLower.includes('net_income') || outputLower.includes('netincome')) {
                inferredCategory = 'Net Income';
              } else if (outputLower.includes('profit')) {
                inferredCategory = 'Profit';
              } else if (outputLower.includes('revenue')) {
                inferredCategory = 'Revenue';
              } else if (outputLower.includes('expense') || outputLower.includes('opex')) {
                inferredCategory = 'Operating Expenses';
              } else if (outputLower.includes('cogs') || outputLower.includes('cost')) {
                inferredCategory = 'Cost of Goods Sold';
              }

              // Check if the output entity exists, if not create it
              const existingOutputEntity = currentModel.data.entities.find(
                e => e.id === actualOutputEntityId || e.name.toLowerCase() === parsed.outputEntity.toLowerCase()
              );

              let entityCreatedMessage = '';
              if (existingOutputEntity) {
                actualOutputEntityId = existingOutputEntity.id;
              } else if (parsed.outputEntity !== 'unknown') {
                // Build attributes with period if we have one
                const entityAttributes: Array<{
                  key: string;
                  value: string | number;
                  dataType: 'currency' | 'string';
                  isComputed: boolean;
                }> = [
                  { key: 'value', value: 0, dataType: 'currency', isComputed: true },
                  { key: 'category', value: inferredCategory, dataType: 'string', isComputed: false },
                ];

                if (inferredPeriod) {
                  entityAttributes.push({
                    key: 'period',
                    value: inferredPeriod,
                    dataType: 'string',
                    isComputed: false,
                  });
                }

                // Create entity and capture its actual ID (UUID)
                actualOutputEntityId = addEntity({
                  name: parsed.outputEntity,
                  type: 'line_item',
                  displayName: parsed.outputEntity,
                  attributes: entityAttributes,
                  metadata: { isComputed: true },
                });
                entityCreatedMessage = ` Created output entity "${parsed.outputEntity}".`;
              }

              const ruleId = addRule({
                name: ruleName,
                description: description || formula,
                type: 'formula',
                definition: {
                  operation: parsed.operation,
                  inputs: resolvedInputs.map(ref => ({
                    type: 'entity' as const,
                    ref,
                    selector: 'value',
                  })),
                  output: {
                    targetEntityId: actualOutputEntityId,
                    targetAttribute: 'value',
                    dataType: 'number' as const,
                  },
                },
                dependencies: resolvedInputs,
                priority: 0,
                enabled: true,
              });

              return {
                success: true,
                message: `Created rule "${ruleName}": ${formula} (ID: ${ruleId}).${entityCreatedMessage}`,
              };
            }
          }

          default:
            return {
              success: false,
              message: `Unknown tool: ${name}`,
            };
        }
      } catch (error) {
        return {
          success: false,
          message: `Error executing ${name}: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
    [createModel, addEntity, setEntityValue, addRule]
  );

  // Run hydration after tool execution
  const runHydration = useCallback(() => {
    const currentModel = useLattice.getState().model;
    if (!currentModel) return;

    const computed = hydrateModel(currentModel);

    // Convert to ILatticeComputedValues format
    const formattedComputed: ILatticeComputedValues = {};
    for (const [entityId, attrs] of Object.entries(computed)) {
      formattedComputed[entityId] = {};
      for (const [key, value] of Object.entries(attrs)) {
        formattedComputed[entityId][key] = {
          value,
          computedByRuleId: 'local-hydration',
          computedAt: new Date(),
        };
      }
    }

    setComputedValues(formattedComputed);
  }, [setComputedValues]);

  // Main chat function
  const sendMessage = useCallback(
    async (message: string) => {
      setState(prev => ({
        ...prev,
        isProcessing: true,
        lastError: null,
        toolResults: [],
      }));

      try {
        // Add user message to history
        const newHistory: ConversationMessage[] = [...state.conversationHistory, { role: 'user', content: message }];

        // Call API with full model state for LLM context
        const response = await chatMutation.mutateAsync({
          message,
          modelId: model?.id,
          modelState: model, // Send full model so LLM knows exact entity IDs
          conversationHistory: state.conversationHistory,
        });

        // Execute tool calls
        const toolResults: Array<{ toolName: string; success: boolean; message: string }> = [];
        let createdModelId: string | undefined;

        for (const toolCall of response.toolCalls) {
          const result = executeToolCall(toolCall);
          toolResults.push({
            toolName: toolCall.name,
            success: result.success,
            message: result.message,
          });

          // Track if we created a new model
          if (toolCall.name === 'lattice_create_model' && result.modelId) {
            createdModelId = result.modelId;
          }
        }

        // Run hydration after all tools executed
        if (toolResults.length > 0) {
          runHydration();
        }

        // Add assistant message to history
        const updatedHistory: ConversationMessage[] = [
          ...newHistory,
          { role: 'assistant', content: response.assistantMessage || 'Tools executed successfully.' },
        ];

        setState(prev => ({
          ...prev,
          isProcessing: false,
          conversationHistory: updatedHistory,
          toolResults,
        }));

        return {
          assistantMessage: response.assistantMessage,
          toolResults,
          modelId: createdModelId || model?.id,
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
        setState(prev => ({
          ...prev,
          isProcessing: false,
          lastError: errorMessage,
        }));
        throw error;
      }
    },
    [state.conversationHistory, model, chatMutation, executeToolCall, runHydration]
  );

  // Clear conversation
  const clearConversation = useCallback(() => {
    setState({
      isProcessing: false,
      lastError: null,
      conversationHistory: [],
      toolResults: [],
    });
  }, []);

  return {
    ...state,
    model,
    sendMessage,
    clearConversation,
    runHydration,
  };
}
