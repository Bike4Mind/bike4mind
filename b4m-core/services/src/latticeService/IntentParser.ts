import { Logger } from '@bike4mind/observability';
/**
 * IntentParser
 *
 * Converts natural language input into structured Lattice operations
 * using LLM structured output (JSON mode with schema).
 */

import type {
  ILatticeModel,
  ILatticeParsedIntent,
  ILatticeOperation,
  ILatticeError,
  LatticeIntentType,
} from '@bike4mind/common';

// TYPES

/**
 * Options for parsing
 */
export interface ParseOptions {
  model: ILatticeModel | null;
  context?: string; // Additional context about the model
  maxSuggestions?: number;
}

/**
 * Result of parsing
 */
export interface ParseResult {
  intent: ILatticeParsedIntent;
  suggestedOperations: ILatticeOperation[];
  errors: ILatticeError[];
}

/**
 * LLM interface for structured output
 */
export interface LLMInterface {
  complete: (options: {
    messages: Array<{ role: string; content: string }>;
    temperature?: number;
    responseFormat?: { type: string; schema?: object };
  }) => Promise<{ content: string }>;
}

// INTENT PARSER

export class IntentParser {
  private llm: LLMInterface | null = null;

  /**
   * Set the LLM interface for structured output parsing
   */
  setLLM(llm: LLMInterface): void {
    this.llm = llm;
  }

  /**
   * Parse natural language input into a structured intent
   */
  async parse(input: string, options: ParseOptions): Promise<ParseResult> {
    const { model, context, maxSuggestions = 3 } = options;

    // If no LLM available, use rule-based parsing
    if (!this.llm) {
      return this.parseWithRules(input, model);
    }

    // Use LLM for structured output
    return this.parseWithLLM(input, model, context, maxSuggestions);
  }

  /**
   * Parse using LLM structured output
   */
  private async parseWithLLM(
    input: string,
    model: ILatticeModel | null,
    context: string | undefined,
    maxSuggestions: number
  ): Promise<ParseResult> {
    const systemPrompt = this.buildSystemPrompt(model, context);
    const userPrompt = input;

    try {
      const response = await this.llm!.complete({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.1, // Low temperature for deterministic parsing
        responseFormat: {
          type: 'json_object',
        },
      });

      const parsed = JSON.parse(response.content);
      return this.validateAndTransform(parsed, input, model);
    } catch (error) {
      Logger.globalInstance.warn('LLM parsing failed, falling back to rules:', error);
      return this.parseWithRules(input, model);
    }
  }

  /**
   * Build system prompt for LLM parsing
   */
  private buildSystemPrompt(model: ILatticeModel | null, context?: string): string {
    const entityList = model?.data.entities.map(e => e.name).join(', ') || 'none';
    const ruleList = model?.rules.rules.map(r => r.name).join(', ') || 'none';

    return `You are a financial modeling intent parser. Parse the user's natural language input into a structured JSON response.

CURRENT MODEL STATE:
- Model name: ${model?.name || 'No model loaded'}
- Entities: ${entityList}
- Rules: ${ruleList}
${context ? `\nContext: ${context}` : ''}

INTENT TYPES:
- CREATE_ENTITY: User wants to add a new line item, account, or entity
- SET_VALUE: User provides a specific value for an entity
- CREATE_RULE: User defines a formula or calculation
- QUERY_VALUE: User asks about a specific value
- QUERY_AGGREGATE: User asks for totals, averages, or comparisons
- CREATE_VIEW: User wants to see data in a specific format
- COMPARE: User wants to compare values or scenarios
- FORECAST: User wants to project future values
- EXPLAIN: User wants to understand how a value was calculated
- UNDO: User wants to revert the last change
- REDO: User wants to redo an undone change
- LIST: User wants to see available entities or rules
- DELETE: User wants to remove an entity or rule
- AMBIGUOUS: Intent is unclear

RESPONSE FORMAT (JSON):
{
  "intent": "INTENT_TYPE",
  "confidence": 0.0-1.0,
  "entities": [
    {
      "type": "line_item_name|period|amount|percentage|operation|entity_reference",
      "value": "extracted value",
      "normalizedValue": "normalized form (optional)",
      "confidence": 0.0-1.0
    }
  ],
  "suggestedOperation": {
    "type": "operation type",
    "params": { ... }
  },
  "clarificationNeeded": "question to ask if ambiguous (optional)"
}

EXAMPLES:

Input: "Add a Revenue line item"
{
  "intent": "CREATE_ENTITY",
  "confidence": 0.95,
  "entities": [{"type": "line_item_name", "value": "Revenue", "confidence": 0.95}],
  "suggestedOperation": {"type": "CREATE_ENTITY", "params": {"name": "Revenue", "entityType": "line_item"}}
}

Input: "Q1 revenue is 150,000"
{
  "intent": "SET_VALUE",
  "confidence": 0.9,
  "entities": [
    {"type": "entity_reference", "value": "revenue", "confidence": 0.9},
    {"type": "period", "value": "Q1", "confidence": 0.95},
    {"type": "amount", "value": "150000", "normalizedValue": 150000, "confidence": 0.95}
  ],
  "suggestedOperation": {"type": "SET_VALUE", "params": {"entityName": "Revenue", "attributeKey": "Q1", "value": 150000}}
}

Input: "Gross Profit equals Revenue minus COGS"
{
  "intent": "CREATE_RULE",
  "confidence": 0.95,
  "entities": [
    {"type": "line_item_name", "value": "Gross Profit", "confidence": 0.95},
    {"type": "entity_reference", "value": "Revenue", "confidence": 0.9},
    {"type": "operation", "value": "minus", "normalizedValue": "SUBTRACT", "confidence": 0.95},
    {"type": "entity_reference", "value": "COGS", "confidence": 0.9}
  ],
  "suggestedOperation": {"type": "CREATE_RULE", "params": {"name": "Gross Profit", "formula": "Revenue - COGS", "operation": "SUBTRACT"}}
}

Parse the input and return only valid JSON.`;
  }

  /**
   * Validate and transform LLM response
   */
  private validateAndTransform(
    parsed: Record<string, unknown>,
    rawInput: string,
    model: ILatticeModel | null
  ): ParseResult {
    const intent: ILatticeParsedIntent = {
      intent: (parsed.intent as LatticeIntentType) || 'AMBIGUOUS',
      confidence: (parsed.confidence as number) || 0.5,
      entities: (parsed.entities as ILatticeParsedIntent['entities']) || [],
      rawInput,
      normalizedInput: rawInput.toLowerCase().trim(),
      clarificationNeeded: parsed.clarificationNeeded as string | undefined,
    };

    // Generate suggested operations
    const suggestedOperations: ILatticeOperation[] = [];
    if (parsed.suggestedOperation) {
      const op = parsed.suggestedOperation as Record<string, unknown>;
      suggestedOperations.push({
        id: `op_${Date.now()}`,
        type: this.mapIntentToOperationType(intent.intent),
        timestamp: new Date(),
        data: (op.params as Record<string, unknown>) || {},
        inverse: {},
        description: `${intent.intent}: ${rawInput}`,
      });
    }

    // Check for ambiguous references
    const errors: ILatticeError[] = [];
    if (model) {
      for (const entity of intent.entities) {
        if (entity.type === 'entity_reference') {
          const matches = this.findMatchingEntities(entity.value, model);
          if (matches.length === 0) {
            // Entity not found - suggest creating it
            intent.ambiguousRefs = intent.ambiguousRefs || [];
            intent.ambiguousRefs.push({
              value: entity.value,
              candidates: [`Create new entity: ${entity.value}`],
            });
          } else if (matches.length > 1) {
            // Multiple matches - ambiguous
            intent.ambiguousRefs = intent.ambiguousRefs || [];
            intent.ambiguousRefs.push({
              value: entity.value,
              candidates: matches,
            });
          }
        }
      }
    }

    return {
      intent,
      suggestedOperations,
      errors,
    };
  }

  /**
   * Find entities matching a reference
   */
  private findMatchingEntities(reference: string, model: ILatticeModel): string[] {
    const normalized = reference.toLowerCase();
    return model.data.entities
      .filter(
        e =>
          e.name.toLowerCase().includes(normalized) ||
          (e.displayName && e.displayName.toLowerCase().includes(normalized))
      )
      .map(e => e.name);
  }

  /**
   * Map intent type to operation type
   */
  private mapIntentToOperationType(intent: LatticeIntentType): ILatticeOperation['type'] {
    const mapping: Record<LatticeIntentType, ILatticeOperation['type']> = {
      CREATE_ENTITY: 'CREATE_ENTITY',
      SET_VALUE: 'SET_VALUE',
      CREATE_RULE: 'CREATE_RULE',
      QUERY_VALUE: 'SET_VALUE', // Query doesn't modify but needs a type
      QUERY_AGGREGATE: 'SET_VALUE',
      CREATE_VIEW: 'CREATE_VIEW',
      COMPARE: 'SET_VALUE',
      FORECAST: 'SET_VALUE',
      EXPLAIN: 'SET_VALUE',
      UNDO: 'UPDATE_ENTITY',
      REDO: 'UPDATE_ENTITY',
      LIST: 'SET_VALUE',
      DELETE: 'DELETE_ENTITY',
      AMBIGUOUS: 'SET_VALUE',
    };
    return mapping[intent] || 'SET_VALUE';
  }

  /**
   * Parse using rule-based patterns (fallback)
   */
  private parseWithRules(input: string, model: ILatticeModel | null): ParseResult {
    const normalized = input.toLowerCase().trim();
    const entities: ILatticeParsedIntent['entities'] = [];
    let intent: LatticeIntentType = 'AMBIGUOUS';
    let confidence = 0.5;

    // Pattern: "Add [entity]" or "Create [entity]"
    const createMatch = normalized.match(/^(?:add|create|new)\s+(?:a\s+)?(.+?)(?:\s+line\s+item)?$/i);
    if (createMatch) {
      intent = 'CREATE_ENTITY';
      confidence = 0.8;
      entities.push({
        type: 'line_item_name',
        value: createMatch[1],
        position: { start: input.indexOf(createMatch[1]), end: input.indexOf(createMatch[1]) + createMatch[1].length },
        confidence: 0.8,
      });
    }

    // Pattern: "[entity] is [amount]" or "Set [entity] to [amount]"
    const setMatch = normalized.match(/(?:set\s+)?(.+?)\s+(?:is|to|=|equals?)\s+\$?([\d,]+(?:\.\d+)?)/i);
    if (setMatch) {
      intent = 'SET_VALUE';
      confidence = 0.85;
      entities.push({
        type: 'entity_reference',
        value: setMatch[1],
        position: { start: 0, end: setMatch[1].length },
        confidence: 0.8,
      });
      entities.push({
        type: 'amount',
        value: setMatch[2],
        normalizedValue: parseFloat(setMatch[2].replace(/,/g, '')),
        position: { start: input.indexOf(setMatch[2]), end: input.indexOf(setMatch[2]) + setMatch[2].length },
        confidence: 0.9,
      });
    }

    // Pattern: "[output] = [input1] +/- [input2]"
    const formulaMatch = normalized.match(/(.+?)\s*(?:=|equals?)\s*(.+?)\s*([+\-*/])\s*(.+)/i);
    if (formulaMatch && !setMatch) {
      intent = 'CREATE_RULE';
      confidence = 0.85;
      entities.push({
        type: 'line_item_name',
        value: formulaMatch[1].trim(),
        position: { start: 0, end: formulaMatch[1].length },
        confidence: 0.85,
      });
      entities.push({
        type: 'entity_reference',
        value: formulaMatch[2].trim(),
        position: {
          start: input.indexOf(formulaMatch[2]),
          end: input.indexOf(formulaMatch[2]) + formulaMatch[2].length,
        },
        confidence: 0.8,
      });
      entities.push({
        type: 'operation',
        value: formulaMatch[3],
        normalizedValue: this.normalizeOperator(formulaMatch[3]),
        position: { start: input.indexOf(formulaMatch[3]), end: input.indexOf(formulaMatch[3]) + 1 },
        confidence: 0.95,
      });
      entities.push({
        type: 'entity_reference',
        value: formulaMatch[4].trim(),
        position: {
          start: input.indexOf(formulaMatch[4]),
          end: input.indexOf(formulaMatch[4]) + formulaMatch[4].length,
        },
        confidence: 0.8,
      });
    }

    // Pattern: "What is [entity]?" or "Show [entity]"
    const queryMatch = normalized.match(/(?:what(?:'s|\s+is)|show|get)\s+(?:the\s+)?(.+?)(?:\?)?$/i);
    if (queryMatch) {
      intent = 'QUERY_VALUE';
      confidence = 0.8;
      entities.push({
        type: 'entity_reference',
        value: queryMatch[1],
        position: { start: input.indexOf(queryMatch[1]), end: input.indexOf(queryMatch[1]) + queryMatch[1].length },
        confidence: 0.75,
      });
    }

    // Pattern: "Explain [entity]" or "How is [entity] calculated"
    const explainMatch = normalized.match(/(?:explain|how\s+is)\s+(.+?)(?:\s+calculated)?(?:\?)?$/i);
    if (explainMatch) {
      intent = 'EXPLAIN';
      confidence = 0.85;
      entities.push({
        type: 'entity_reference',
        value: explainMatch[1],
        position: {
          start: input.indexOf(explainMatch[1]),
          end: input.indexOf(explainMatch[1]) + explainMatch[1].length,
        },
        confidence: 0.8,
      });
    }

    // Pattern: "Undo" or "Redo"
    if (normalized === 'undo') {
      intent = 'UNDO';
      confidence = 1.0;
    } else if (normalized === 'redo') {
      intent = 'REDO';
      confidence = 1.0;
    }

    // Pattern: "List entities" or "Show all"
    if (normalized.match(/^(?:list|show\s+all)\s*(?:entities|items|rules)?$/)) {
      intent = 'LIST';
      confidence = 0.9;
    }

    return {
      intent: {
        intent,
        confidence,
        entities,
        rawInput: input,
        normalizedInput: normalized,
      },
      suggestedOperations: [],
      errors: [],
    };
  }

  /**
   * Normalize operator symbol to operation name
   */
  private normalizeOperator(op: string): string {
    const mapping: Record<string, string> = {
      '+': 'ADD',
      '-': 'SUBTRACT',
      '*': 'MULTIPLY',
      '/': 'DIVIDE',
      plus: 'ADD',
      minus: 'SUBTRACT',
      times: 'MULTIPLY',
      'divided by': 'DIVIDE',
    };
    return mapping[op.toLowerCase()] || 'REFERENCE';
  }
}

// FACTORY

export function createIntentParser(): IntentParser {
  return new IntentParser();
}
