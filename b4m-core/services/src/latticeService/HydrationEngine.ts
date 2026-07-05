/**
 * HydrationEngine
 *
 * The core computation engine for Lattice. Takes raw data and rules,
 * applies formulas in topological order, and produces computed values.
 */

import type {
  ILatticeDataStore,
  ILatticeRulesStore,
  ILatticeRule,
  ILatticeComputedValues,
  ILatticeScenario,
  ILatticeError,
  PrimitiveValue,
  LatticeOperation,
} from '@bike4mind/common';

import { DependencyTracker, createDependencyTracker } from './DependencyTracker';

// TYPES

/**
 * Result of hydration (computation)
 */
export interface HydrationResult {
  values: ILatticeComputedValues;
  errors: ILatticeError[];
  duration: number; // milliseconds
  rulesEvaluated: number;
}

/**
 * Options for hydration
 */
export interface HydrationOptions {
  scenario?: ILatticeScenario;
  partialRuleIds?: string[]; // Only evaluate these rules (and their dependencies)
  maxIterations?: number; // For iterative formulas (default 1000)
  tolerance?: number; // For convergence (default 0.0001)
}

/**
 * Internal context for rule evaluation
 */
interface EvaluationContext {
  data: ILatticeDataStore;
  rules: ILatticeRulesStore;
  computedValues: ILatticeComputedValues;
  scenario?: ILatticeScenario;
  errors: ILatticeError[];
}

// HYDRATION ENGINE CLASS

export class HydrationEngine {
  private dependencyTracker: DependencyTracker;

  constructor() {
    this.dependencyTracker = createDependencyTracker();
  }

  /**
   * Hydrate (compute) all values from data and rules
   */
  hydrate(data: ILatticeDataStore, rules: ILatticeRulesStore, options: HydrationOptions = {}): HydrationResult {
    const startTime = performance.now();
    const errors: ILatticeError[] = [];

    // Build dependency graph
    this.dependencyTracker.build(rules);

    // Validate for cycles
    const validation = this.dependencyTracker.validate();
    if (!validation.isValid) {
      return {
        values: {},
        errors: validation.errors,
        duration: performance.now() - startTime,
        rulesEvaluated: 0,
      };
    }

    // Initialize computed values with base data
    const computedValues: ILatticeComputedValues = this.initializeFromData(data, options.scenario);

    // Create evaluation context
    const context: EvaluationContext = {
      data,
      rules,
      computedValues,
      scenario: options.scenario,
      errors,
    };

    // Get computation order
    let ruleOrder = this.dependencyTracker.getComputationOrder();

    // Filter to partial rules if specified
    if (options.partialRuleIds && options.partialRuleIds.length > 0) {
      const neededRules = this.getNeededRules(options.partialRuleIds);
      ruleOrder = ruleOrder.filter(id => neededRules.has(id));
    }

    // Evaluate rules in topological order
    let rulesEvaluated = 0;
    for (const ruleId of ruleOrder) {
      const rule = rules.rules.find(r => r.id === ruleId);
      if (!rule || !rule.enabled) continue;

      try {
        this.evaluateRule(rule, context);
        rulesEvaluated++;
      } catch (error) {
        errors.push({
          type: 'INVALID_OPERATION',
          message: `Error evaluating rule "${rule.name}": ${error instanceof Error ? error.message : String(error)}`,
          context: { relatedRules: [ruleId] },
        });
      }
    }

    return {
      values: computedValues,
      errors,
      duration: performance.now() - startTime,
      rulesEvaluated,
    };
  }

  /**
   * Initialize computed values from base data (including scenario overrides)
   */
  private initializeFromData(data: ILatticeDataStore, scenario?: ILatticeScenario): ILatticeComputedValues {
    const values: ILatticeComputedValues = {};

    // First, add all base values
    for (const entity of data.entities) {
      values[entity.id] = {};
      for (const attr of entity.attributes) {
        if (!attr.isComputed) {
          values[entity.id][attr.key] = {
            value: attr.value,
            computedByRuleId: 'base',
            computedAt: new Date(),
          };
        }
      }
    }

    // Apply scenario overrides if present
    if (scenario) {
      for (const override of scenario.overrides) {
        if (!values[override.entityId]) {
          values[override.entityId] = {};
        }
        values[override.entityId][override.attributeKey] = {
          value: override.value,
          computedByRuleId: `scenario:${scenario.id}`,
          computedAt: new Date(),
        };
      }
    }

    return values;
  }

  /**
   * Get all rules needed to compute the given rules (including dependencies)
   */
  private getNeededRules(ruleIds: string[]): Set<string> {
    const needed = new Set<string>();

    const addWithDependencies = (ruleId: string) => {
      if (needed.has(ruleId)) return;
      needed.add(ruleId);

      const deps = this.dependencyTracker.getDependencies(ruleId);
      for (const depId of deps) {
        addWithDependencies(depId);
      }
    };

    for (const ruleId of ruleIds) {
      addWithDependencies(ruleId);
    }

    return needed;
  }

  /**
   * Evaluate a single rule and store results
   */
  private evaluateRule(rule: ILatticeRule, context: EvaluationContext): void {
    const { definition } = rule;

    // Gather input values
    const inputValues = this.resolveInputs(definition.inputs, context);

    // Check conditions if present
    if (definition.conditions && definition.conditions.length > 0) {
      const conditionsMet = this.evaluateConditions(definition.conditions, context);
      if (!conditionsMet) return;
    }

    // Apply operation
    const result = this.applyOperation(definition.operation, inputValues, context);

    // Store result
    const { targetEntityId, targetAttribute } = definition.output;

    if (!context.computedValues[targetEntityId]) {
      context.computedValues[targetEntityId] = {};
    }

    context.computedValues[targetEntityId][targetAttribute] = {
      value: result,
      computedByRuleId: rule.id,
      computedAt: new Date(),
    };
  }

  /**
   * Resolve input references to actual values
   */
  private resolveInputs(inputs: ILatticeRule['definition']['inputs'], context: EvaluationContext): PrimitiveValue[] {
    const values: PrimitiveValue[] = [];

    for (const input of inputs) {
      switch (input.type) {
        case 'literal':
          values.push(this.parseLiteral(input.ref));
          break;

        case 'attribute':
        case 'entity': {
          const [entityId, attrKey] = input.selector ? [input.ref, input.selector] : input.ref.split('.');

          const entityValues = context.computedValues[entityId];
          if (entityValues && attrKey in entityValues) {
            values.push(entityValues[attrKey].value);
          } else {
            values.push(null); // Missing value
          }
          break;
        }

        case 'rule': {
          // Get the output of another rule
          const rule = context.rules.rules.find(r => r.id === input.ref);
          if (rule) {
            const { targetEntityId, targetAttribute } = rule.definition.output;
            const entityValues = context.computedValues[targetEntityId];
            if (entityValues && targetAttribute in entityValues) {
              values.push(entityValues[targetAttribute].value);
            } else {
              values.push(null);
            }
          } else {
            values.push(null);
          }
          break;
        }

        case 'range': {
          // Collect values from a range (e.g., all periods)
          const rangeValues = this.resolveRange(input.ref, input.selector, context);
          values.push(...rangeValues);
          break;
        }

        default:
          values.push(null);
      }
    }

    return values;
  }

  /**
   * Resolve a range reference to multiple values
   */
  private resolveRange(
    entityPattern: string,
    selector: string | undefined,
    context: EvaluationContext
  ): PrimitiveValue[] {
    const values: PrimitiveValue[] = [];

    // Handle wildcard patterns like "Revenue.*" (all attributes of Revenue)
    // or "*.Q1_2024" (Q1_2024 attribute of all entities)
    if (entityPattern.includes('*')) {
      // Find matching entities
      for (const [entityId, entityValues] of Object.entries(context.computedValues)) {
        if (this.matchesPattern(entityId, entityPattern)) {
          if (selector === '*') {
            // All attributes
            values.push(...Object.values(entityValues).map(v => v.value));
          } else if (selector) {
            // Specific attribute
            if (selector in entityValues) {
              values.push(entityValues[selector].value);
            }
          }
        }
      }
    } else {
      // Specific entity, multiple attributes
      const entityValues = context.computedValues[entityPattern];
      if (entityValues) {
        if (selector === '*') {
          values.push(...Object.values(entityValues).map(v => v.value));
        }
      }
    }

    return values;
  }

  /**
   * Check if an entity ID matches a pattern
   */
  private matchesPattern(entityId: string, pattern: string): boolean {
    // Simple wildcard matching
    if (pattern === '*') return true;
    if (!pattern.includes('*')) return entityId === pattern;

    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    return regex.test(entityId);
  }

  /**
   * Parse a literal string to a value
   */
  private parseLiteral(value: string): PrimitiveValue {
    // Try number
    const num = parseFloat(value);
    if (!isNaN(num)) return num;

    // Try boolean
    if (value.toLowerCase() === 'true') return true;
    if (value.toLowerCase() === 'false') return false;

    // Return as string
    return value;
  }

  /**
   * Evaluate rule conditions
   */
  private evaluateConditions(
    conditions: ILatticeRule['definition']['conditions'],
    context: EvaluationContext
  ): boolean {
    if (!conditions || conditions.length === 0) return true;

    let result = true;
    let currentJoin: 'AND' | 'OR' | undefined;

    for (const condition of conditions) {
      const leftValue = this.resolveInputs([condition.left], context)[0];
      const rightValue = this.resolveInputs([condition.right], context)[0];

      const conditionResult = this.evaluateComparison(leftValue, condition.operator, rightValue);

      if (currentJoin === 'OR') {
        result = result || conditionResult;
      } else {
        result = result && conditionResult;
      }

      currentJoin = condition.logicalJoin;
    }

    return result;
  }

  /**
   * Evaluate a comparison
   */
  private evaluateComparison(left: PrimitiveValue, operator: string, right: PrimitiveValue): boolean {
    switch (operator) {
      case '==':
        return left === right;
      case '!=':
        return left !== right;
      case '>':
        return (left as number) > (right as number);
      case '<':
        return (left as number) < (right as number);
      case '>=':
        return (left as number) >= (right as number);
      case '<=':
        return (left as number) <= (right as number);
      case 'contains':
        return String(left).includes(String(right));
      case 'in':
        return Array.isArray(right) && right.includes(left);
      default:
        return false;
    }
  }

  /**
   * Apply an operation to input values
   */
  private applyOperation(
    operation: LatticeOperation,
    inputs: PrimitiveValue[],
    context: EvaluationContext
  ): PrimitiveValue {
    // Filter out nulls for numeric operations
    const numericInputs = inputs.filter(v => v !== null && typeof v === 'number').map(v => v as number);

    switch (operation) {
      // Arithmetic
      case 'ADD':
        return numericInputs.reduce((a, b) => a + b, 0);

      case 'SUBTRACT':
        if (numericInputs.length === 0) return 0;
        return numericInputs.slice(1).reduce((a, b) => a - b, numericInputs[0]);

      case 'MULTIPLY':
        return numericInputs.reduce((a, b) => a * b, 1);

      case 'DIVIDE':
        if (numericInputs.length < 2 || numericInputs[1] === 0) {
          context.errors.push({
            type: 'DIVISION_BY_ZERO',
            message: 'Division by zero',
          });
          return null;
        }
        return numericInputs[0] / numericInputs[1];

      case 'ABS':
        return numericInputs.length > 0 ? Math.abs(numericInputs[0]) : 0;

      case 'ROUND': {
        if (numericInputs.length === 0) return 0;
        const decimals = numericInputs[1] ?? 0;
        const factor = Math.pow(10, decimals);
        return Math.round(numericInputs[0] * factor) / factor;
      }

      case 'FLOOR':
        return numericInputs.length > 0 ? Math.floor(numericInputs[0]) : 0;

      case 'CEIL':
        return numericInputs.length > 0 ? Math.ceil(numericInputs[0]) : 0;

      case 'POWER':
        if (numericInputs.length < 2) return numericInputs[0] ?? 0;
        return Math.pow(numericInputs[0], numericInputs[1]);

      case 'SQRT':
        return numericInputs.length > 0 ? Math.sqrt(numericInputs[0]) : 0;

      // Aggregation
      case 'SUM':
        return numericInputs.reduce((a, b) => a + b, 0);

      case 'AVERAGE':
        if (numericInputs.length === 0) return 0;
        return numericInputs.reduce((a, b) => a + b, 0) / numericInputs.length;

      case 'MIN':
        return numericInputs.length > 0 ? Math.min(...numericInputs) : 0;

      case 'MAX':
        return numericInputs.length > 0 ? Math.max(...numericInputs) : 0;

      case 'COUNT':
        return inputs.filter(v => v !== null).length;

      case 'MEDIAN': {
        if (numericInputs.length === 0) return 0;
        const sorted = [...numericInputs].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
      }

      // Logical
      case 'IF':
        // IF(condition, trueValue, falseValue)
        return inputs[0] ? inputs[1] : inputs[2];

      case 'AND':
        return inputs.every(v => Boolean(v));

      case 'OR':
        return inputs.some(v => Boolean(v));

      case 'NOT':
        return !inputs[0];

      case 'EQUALS':
        return inputs.length >= 2 && inputs[0] === inputs[1];

      case 'GREATER_THAN':
        return inputs.length >= 2 && (inputs[0] as number) > (inputs[1] as number);

      case 'LESS_THAN':
        return inputs.length >= 2 && (inputs[0] as number) < (inputs[1] as number);

      case 'GREATER_THAN_OR_EQUAL':
        return inputs.length >= 2 && (inputs[0] as number) >= (inputs[1] as number);

      case 'LESS_THAN_OR_EQUAL':
        return inputs.length >= 2 && (inputs[0] as number) <= (inputs[1] as number);

      case 'BETWEEN': {
        if (inputs.length < 3) return false;
        const val = inputs[0] as number;
        const min = inputs[1] as number;
        const max = inputs[2] as number;
        return val >= min && val <= max;
      }

      // Financial
      case 'PERCENT_OF':
        if (numericInputs.length < 2 || numericInputs[1] === 0) return 0;
        return (numericInputs[0] / numericInputs[1]) * 100;

      case 'GROWTH_RATE':
        if (numericInputs.length < 2 || numericInputs[1] === 0) return 0;
        return ((numericInputs[0] - numericInputs[1]) / numericInputs[1]) * 100;

      case 'NPV': {
        // NPV(rate, cashflows...)
        if (numericInputs.length < 2) return 0;
        const rate = numericInputs[0];
        const cashflows = numericInputs.slice(1);
        return cashflows.reduce((npv, cf, i) => npv + cf / Math.pow(1 + rate, i + 1), 0);
      }

      case 'IRR':
        // Simplified IRR using Newton's method (basic implementation)
        return this.calculateIRR(numericInputs);

      case 'PMT': {
        // PMT(rate, nper, pv, [fv], [type])
        if (numericInputs.length < 3) return 0;
        const [rate, nper, pv, fv = 0, type = 0] = numericInputs;
        if (rate === 0) return -(pv + fv) / nper;
        const pvif = Math.pow(1 + rate, nper);
        let pmt = (rate * (pv * pvif + fv)) / (pvif - 1);
        if (type === 1) pmt = pmt / (1 + rate);
        return -pmt;
      }

      case 'FV': {
        // FV(rate, nper, pmt, [pv], [type])
        if (numericInputs.length < 3) return 0;
        const [rate, nper, pmt, pv = 0, type = 0] = numericInputs;
        if (rate === 0) return -(pv + pmt * nper);
        const pvif = Math.pow(1 + rate, nper);
        let fv = -pv * pvif - (pmt * (pvif - 1)) / rate;
        if (type === 1) fv = fv - pmt * rate * nper;
        return fv;
      }

      case 'PV': {
        // PV(rate, nper, pmt, [fv], [type])
        if (numericInputs.length < 3) return 0;
        const [rate, nper, pmt, fv = 0, type = 0] = numericInputs;
        if (rate === 0) return -(fv + pmt * nper);
        const pvif = Math.pow(1 + rate, nper);
        let pv = (-fv - (pmt * (pvif - 1)) / rate) / pvif;
        if (type === 1) pv = pv / (1 + rate);
        return pv;
      }

      // Special
      case 'REFERENCE':
        return inputs[0]; // Pass through

      case 'LOOKUP': {
        // Simple lookup: value at index
        if (inputs.length < 2) return null;
        const index = inputs[0] as number;
        return inputs[Math.min(index + 1, inputs.length - 1)];
      }

      default:
        context.errors.push({
          type: 'INVALID_OPERATION',
          message: `Unknown operation: ${operation}`,
        });
        return null;
    }
  }

  /**
   * Calculate IRR using Newton's method
   */
  private calculateIRR(cashflows: number[], guess = 0.1, maxIterations = 100, tolerance = 0.0001): number {
    let rate = guess;

    for (let i = 0; i < maxIterations; i++) {
      let npv = 0;
      let dnpv = 0; // derivative

      for (let j = 0; j < cashflows.length; j++) {
        const factor = Math.pow(1 + rate, j);
        npv += cashflows[j] / factor;
        dnpv -= (j * cashflows[j]) / Math.pow(1 + rate, j + 1);
      }

      if (Math.abs(npv) < tolerance) {
        return rate;
      }

      if (dnpv === 0) break;
      rate = rate - npv / dnpv;
    }

    return rate;
  }

  /**
   * Get the dependency tracker (for advanced use cases)
   */
  getDependencyTracker(): DependencyTracker {
    return this.dependencyTracker;
  }
}

// FACTORY FUNCTION

/**
 * Create a new HydrationEngine
 */
export function createHydrationEngine(): HydrationEngine {
  return new HydrationEngine();
}
