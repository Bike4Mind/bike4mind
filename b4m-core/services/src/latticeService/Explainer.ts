/**
 * Explainer
 *
 * Provides human-readable explanations of how computed values were derived.
 * Traces the calculation chain from a target value back through all its dependencies.
 */

import type {
  ILatticeDataStore,
  ILatticeRulesStore,
  ILatticeRule,
  ILatticeComputedValues,
  ILatticeCalculationChain,
  ILatticeCalculationStep,
  PrimitiveValue,
} from '@bike4mind/common';

import { DependencyTracker, createDependencyTracker } from './DependencyTracker';

// TYPES

/**
 * Options for explanation generation
 */
export interface ExplainOptions {
  maxDepth?: number; // Maximum depth of explanation (default: 10)
  includeBaseValues?: boolean; // Include non-computed base values (default: true)
  formatNumbers?: boolean; // Format numbers for display (default: true)
}

/**
 * A formatted explanation for display
 */
export interface FormattedExplanation {
  summary: string;
  steps: FormattedStep[];
  naturalLanguage: string;
}

/**
 * A single formatted step
 */
export interface FormattedStep {
  level: number; // Indentation level
  description: string;
  formula: string;
  result: string;
  ruleId?: string;
}

// EXPLAINER CLASS

export class Explainer {
  private dependencyTracker: DependencyTracker;

  constructor() {
    this.dependencyTracker = createDependencyTracker();
  }

  /**
   * Generate a calculation chain explanation for a specific value
   */
  explain(
    entityId: string,
    attributeKey: string,
    data: ILatticeDataStore,
    rules: ILatticeRulesStore,
    computedValues: ILatticeComputedValues,
    options: ExplainOptions = {}
  ): ILatticeCalculationChain {
    const { maxDepth = 10, includeBaseValues = true } = options;

    // Build dependency tracker
    this.dependencyTracker.build(rules);

    // Get the computed value
    const entityValues = computedValues[entityId];
    if (!entityValues || !(attributeKey in entityValues)) {
      return {
        targetEntity: entityId,
        targetAttribute: attributeKey,
        finalValue: null,
        steps: [],
      };
    }

    const finalValue = entityValues[attributeKey].value;
    const computedByRuleId = entityValues[attributeKey].computedByRuleId;

    // If it's a base value, return simple chain
    if (computedByRuleId === 'base' || computedByRuleId.startsWith('scenario:')) {
      const steps: ILatticeCalculationStep[] = [];

      if (includeBaseValues) {
        steps.push({
          ruleId: computedByRuleId,
          ruleName: computedByRuleId === 'base' ? 'Base Value' : 'Scenario Override',
          operation: 'REFERENCE',
          inputs: [{ name: 'value', value: finalValue }],
          output: finalValue,
        });
      }

      return {
        targetEntity: entityId,
        targetAttribute: attributeKey,
        finalValue,
        steps,
      };
    }

    // Build calculation chain by tracing dependencies
    const steps: ILatticeCalculationStep[] = [];
    const visited = new Set<string>();

    this.traceCalculation(computedByRuleId, rules, computedValues, steps, visited, 0, maxDepth, includeBaseValues);

    // Reverse steps so they go from inputs to output
    steps.reverse();

    return {
      targetEntity: entityId,
      targetAttribute: attributeKey,
      finalValue,
      steps,
    };
  }

  /**
   * Recursively trace calculation through rule dependencies
   */
  private traceCalculation(
    ruleId: string,
    rules: ILatticeRulesStore,
    computedValues: ILatticeComputedValues,
    steps: ILatticeCalculationStep[],
    visited: Set<string>,
    depth: number,
    maxDepth: number,
    includeBaseValues: boolean
  ): void {
    if (depth > maxDepth || visited.has(ruleId)) return;
    visited.add(ruleId);

    const rule = rules.rules.find(r => r.id === ruleId);
    if (!rule) return;

    // Get input values for this rule
    const inputValues: Array<{ name: string; value: PrimitiveValue }> = [];

    for (const input of rule.definition.inputs) {
      const inputName = this.getInputName(input);
      const inputValue = this.resolveInputValue(input, computedValues);
      inputValues.push({ name: inputName, value: inputValue });

      // Trace dependencies of this input
      if (input.type === 'attribute' || input.type === 'entity') {
        const [inputEntityId, inputAttrKey] = input.selector ? [input.ref, input.selector] : input.ref.split('.');

        const entityValues = computedValues[inputEntityId];
        if (entityValues && inputAttrKey in entityValues) {
          const inputComputedBy = entityValues[inputAttrKey].computedByRuleId;

          if (inputComputedBy !== 'base' && !inputComputedBy.startsWith('scenario:')) {
            // Recurse into dependency
            this.traceCalculation(
              inputComputedBy,
              rules,
              computedValues,
              steps,
              visited,
              depth + 1,
              maxDepth,
              includeBaseValues
            );
          } else if (includeBaseValues) {
            // Add base value step
            steps.push({
              ruleId: inputComputedBy,
              ruleName: inputComputedBy === 'base' ? 'Base Value' : 'Scenario Override',
              operation: 'REFERENCE',
              inputs: [{ name: inputName, value: inputValue }],
              output: inputValue,
            });
          }
        }
      } else if (input.type === 'rule') {
        // Recurse into rule dependency
        this.traceCalculation(input.ref, rules, computedValues, steps, visited, depth + 1, maxDepth, includeBaseValues);
      }
    }

    // Get output value
    const { targetEntityId, targetAttribute } = rule.definition.output;
    const outputEntityValues = computedValues[targetEntityId];
    const outputValue = outputEntityValues?.[targetAttribute]?.value ?? null;

    // Add this rule's step
    steps.push({
      ruleId: rule.id,
      ruleName: rule.name,
      operation: rule.definition.operation,
      inputs: inputValues,
      output: outputValue,
    });
  }

  /**
   * Get a human-readable name for an input
   */
  private getInputName(input: ILatticeRule['definition']['inputs'][0]): string {
    switch (input.type) {
      case 'literal':
        return input.ref;
      case 'attribute':
      case 'entity':
        return input.selector ? `${input.ref}.${input.selector}` : input.ref;
      case 'rule':
        return `rule:${input.ref}`;
      case 'range':
        return input.selector ? `${input.ref}[${input.selector}]` : input.ref;
      default:
        return input.ref;
    }
  }

  /**
   * Resolve an input to its current value
   */
  private resolveInputValue(
    input: ILatticeRule['definition']['inputs'][0],
    computedValues: ILatticeComputedValues
  ): PrimitiveValue {
    switch (input.type) {
      case 'literal':
        return this.parseLiteral(input.ref);

      case 'attribute':
      case 'entity': {
        const [entityId, attrKey] = input.selector ? [input.ref, input.selector] : input.ref.split('.');

        const entityValues = computedValues[entityId];
        if (entityValues && attrKey in entityValues) {
          return entityValues[attrKey].value;
        }
        return null;
      }

      default:
        return null;
    }
  }

  /**
   * Parse a literal string to a value
   */
  private parseLiteral(value: string): PrimitiveValue {
    const num = parseFloat(value);
    if (!isNaN(num)) return num;
    if (value.toLowerCase() === 'true') return true;
    if (value.toLowerCase() === 'false') return false;
    return value;
  }

  /**
   * Format a calculation chain as human-readable text
   */
  formatExplanation(chain: ILatticeCalculationChain, options: ExplainOptions = {}): FormattedExplanation {
    const { formatNumbers = true } = options;

    const formatValue = (value: PrimitiveValue): string => {
      if (value === null) return 'null';
      if (typeof value === 'number' && formatNumbers) {
        return value.toLocaleString(undefined, {
          minimumFractionDigits: 0,
          maximumFractionDigits: 2,
        });
      }
      return String(value);
    };

    // Format steps
    const formattedSteps: FormattedStep[] = chain.steps.map((step, index) => {
      const inputList = step.inputs.map(i => `${i.name} = ${formatValue(i.value)}`).join(', ');

      return {
        level: index,
        description: step.ruleName,
        formula: `${step.operation}(${inputList})`,
        result: formatValue(step.output),
        ruleId: step.ruleId,
      };
    });

    // Generate summary
    const summary = `${chain.targetEntity}.${chain.targetAttribute} = ${formatValue(chain.finalValue)}`;

    // Generate natural language explanation
    const naturalLanguage = this.generateNaturalLanguage(chain, formatValue);

    return {
      summary,
      steps: formattedSteps,
      naturalLanguage,
    };
  }

  /**
   * Generate a natural language explanation
   */
  private generateNaturalLanguage(chain: ILatticeCalculationChain, formatValue: (v: PrimitiveValue) => string): string {
    if (chain.steps.length === 0) {
      return `The value of ${chain.targetAttribute} for ${chain.targetEntity} is ${formatValue(chain.finalValue)}.`;
    }

    const lines: string[] = [];
    lines.push(`To calculate ${chain.targetAttribute} for ${chain.targetEntity}:`);

    for (let i = 0; i < chain.steps.length; i++) {
      const step = chain.steps[i];
      const stepNum = i + 1;

      if (step.operation === 'REFERENCE') {
        lines.push(`${stepNum}. Start with the ${step.ruleName.toLowerCase()}: ${formatValue(step.output)}`);
      } else {
        const inputDesc = step.inputs.map(i => `${i.name} (${formatValue(i.value)})`).join(' and ');
        const opDesc = this.describeOperation(step.operation);
        lines.push(`${stepNum}. ${opDesc} ${inputDesc} → ${formatValue(step.output)}`);
      }
    }

    lines.push(`\nFinal result: ${formatValue(chain.finalValue)}`);

    return lines.join('\n');
  }

  /**
   * Get a human-readable description of an operation
   */
  private describeOperation(operation: string): string {
    const descriptions: Record<string, string> = {
      ADD: 'Add',
      SUBTRACT: 'Subtract',
      MULTIPLY: 'Multiply',
      DIVIDE: 'Divide',
      SUM: 'Sum of',
      AVERAGE: 'Average of',
      MIN: 'Minimum of',
      MAX: 'Maximum of',
      COUNT: 'Count of',
      PERCENT_OF: 'Calculate percentage:',
      GROWTH_RATE: 'Calculate growth rate:',
      IF: 'Conditionally select',
      ROUND: 'Round',
      ABS: 'Absolute value of',
      REFERENCE: 'Reference',
    };

    return descriptions[operation] || operation;
  }
}

// FACTORY FUNCTION

/**
 * Create a new Explainer
 */
export function createExplainer(): Explainer {
  return new Explainer();
}
