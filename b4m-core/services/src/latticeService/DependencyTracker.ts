import { Logger } from '@bike4mind/observability';
/**
 * DependencyTracker
 *
 * Builds and maintains a Directed Acyclic Graph (DAG) of rule dependencies.
 * Provides topological ordering for computation and cycle detection.
 */

import type { ILatticeRule, ILatticeRulesStore, ILatticeError } from '@bike4mind/common';

// TYPES

/**
 * A node in the dependency graph
 */
export interface DependencyNode {
  ruleId: string;
  dependencies: Set<string>; // Rules this rule depends on
  dependents: Set<string>; // Rules that depend on this rule
}

/**
 * Result of dependency validation
 */
export interface DependencyValidationResult {
  isValid: boolean;
  errors: ILatticeError[];
  cycles: string[][]; // Each array is a cycle path
}

/**
 * Result of computing affected rules
 */
export interface AffectedRulesResult {
  directlyAffected: string[]; // Immediate dependents
  transitivelyAffected: string[]; // All downstream dependents
}

// DEPENDENCY TRACKER CLASS

export class DependencyTracker {
  private nodes: Map<string, DependencyNode> = new Map();
  private topologicalOrder: string[] | null = null;
  private hasChanges = true;

  /**
   * Build the dependency graph from a rules store
   */
  build(rulesStore: ILatticeRulesStore): void {
    this.nodes.clear();
    this.topologicalOrder = null;
    this.hasChanges = true;

    // Initialize nodes for all rules
    for (const rule of rulesStore.rules) {
      if (!rule.enabled) continue;

      this.nodes.set(rule.id, {
        ruleId: rule.id,
        dependencies: new Set(rule.dependencies),
        dependents: new Set(),
      });
    }

    // Build reverse dependency map (dependents)
    for (const node of this.nodes.values()) {
      for (const depId of node.dependencies) {
        const depNode = this.nodes.get(depId);
        if (depNode) {
          depNode.dependents.add(node.ruleId);
        }
      }
    }
  }

  /**
   * Add a single rule to the graph
   */
  addRule(rule: ILatticeRule): void {
    if (!rule.enabled) return;

    this.nodes.set(rule.id, {
      ruleId: rule.id,
      dependencies: new Set(rule.dependencies),
      dependents: new Set(),
    });

    // Update reverse dependencies
    for (const depId of rule.dependencies) {
      const depNode = this.nodes.get(depId);
      if (depNode) {
        depNode.dependents.add(rule.id);
      }
    }

    this.hasChanges = true;
    this.topologicalOrder = null;
  }

  /**
   * Remove a rule from the graph
   */
  removeRule(ruleId: string): void {
    const node = this.nodes.get(ruleId);
    if (!node) return;

    // Remove this rule from dependents of its dependencies
    for (const depId of node.dependencies) {
      const depNode = this.nodes.get(depId);
      if (depNode) {
        depNode.dependents.delete(ruleId);
      }
    }

    // Remove this rule from dependencies of its dependents
    for (const dependentId of node.dependents) {
      const dependentNode = this.nodes.get(dependentId);
      if (dependentNode) {
        dependentNode.dependencies.delete(ruleId);
      }
    }

    this.nodes.delete(ruleId);
    this.hasChanges = true;
    this.topologicalOrder = null;
  }

  /**
   * Update dependencies for a rule
   */
  updateDependencies(ruleId: string, newDependencies: string[]): void {
    const node = this.nodes.get(ruleId);
    if (!node) return;

    // Remove old reverse dependencies
    for (const oldDepId of node.dependencies) {
      const oldDepNode = this.nodes.get(oldDepId);
      if (oldDepNode) {
        oldDepNode.dependents.delete(ruleId);
      }
    }

    // Set new dependencies
    node.dependencies = new Set(newDependencies);

    // Add new reverse dependencies
    for (const newDepId of newDependencies) {
      const newDepNode = this.nodes.get(newDepId);
      if (newDepNode) {
        newDepNode.dependents.add(ruleId);
      }
    }

    this.hasChanges = true;
    this.topologicalOrder = null;
  }

  /**
   * Validate the dependency graph for cycles
   */
  validate(): DependencyValidationResult {
    const errors: ILatticeError[] = [];
    const cycles: string[][] = [];

    // Use DFS to detect cycles
    const visited = new Set<string>();
    const recursionStack = new Set<string>();
    const path: string[] = [];

    const dfs = (ruleId: string): void => {
      visited.add(ruleId);
      recursionStack.add(ruleId);
      path.push(ruleId);

      try {
        const node = this.nodes.get(ruleId);
        if (node) {
          for (const depId of node.dependencies) {
            if (!visited.has(depId)) {
              dfs(depId);
            } else if (recursionStack.has(depId)) {
              // Found a cycle - extract it
              const cycleStart = path.indexOf(depId);
              const cycle = [...path.slice(cycleStart), depId];
              cycles.push(cycle);
              errors.push({
                type: 'CIRCULAR_DEPENDENCY',
                message: `Circular dependency detected: ${cycle.join(' → ')}`,
                context: {
                  relatedRules: cycle,
                },
              });
              // Continue traversal to find additional cycles
            }
          }
        }
      } finally {
        path.pop();
        recursionStack.delete(ruleId);
      }
    };

    // Check all nodes
    for (const ruleId of this.nodes.keys()) {
      if (!visited.has(ruleId)) {
        dfs(ruleId);
      }
    }

    return {
      isValid: cycles.length === 0,
      errors,
      cycles,
    };
  }

  /**
   * Get topological order for computation (dependencies before dependents)
   */
  getComputationOrder(): string[] {
    if (this.topologicalOrder && !this.hasChanges) {
      return this.topologicalOrder;
    }

    // Kahn's algorithm for topological sort
    const inDegree = new Map<string, number>();
    const queue: string[] = [];
    const result: string[] = [];

    // Initialize in-degrees
    for (const [ruleId, node] of this.nodes) {
      inDegree.set(ruleId, node.dependencies.size);
      if (node.dependencies.size === 0) {
        queue.push(ruleId);
      }
    }

    // Process queue (index-based for O(1) dequeue instead of O(n) shift)
    let qi = 0;
    while (qi < queue.length) {
      const ruleId = queue[qi++];
      result.push(ruleId);

      const node = this.nodes.get(ruleId);
      if (node) {
        for (const dependentId of node.dependents) {
          const degree = inDegree.get(dependentId)! - 1;
          inDegree.set(dependentId, degree);
          if (degree === 0) {
            queue.push(dependentId);
          }
        }
      }
    }

    // If not all nodes are in result, there's a cycle
    if (result.length !== this.nodes.size) {
      // Return partial order (best effort)
      Logger.globalInstance.warn('Dependency graph contains cycles; returning partial order');
    }

    this.topologicalOrder = result;
    this.hasChanges = false;
    return result;
  }

  /**
   * Get all rules affected by changes to a specific rule
   */
  getAffectedBy(ruleId: string): AffectedRulesResult {
    const node = this.nodes.get(ruleId);
    if (!node) {
      return { directlyAffected: [], transitivelyAffected: [] };
    }

    const directlyAffected = Array.from(node.dependents);
    const transitivelyAffected = new Set<string>();

    // BFS to find all transitive dependents
    const queue = [...directlyAffected];
    while (queue.length > 0) {
      const currentId = queue.shift()!;
      if (transitivelyAffected.has(currentId)) continue;

      transitivelyAffected.add(currentId);

      const currentNode = this.nodes.get(currentId);
      if (currentNode) {
        for (const dependentId of currentNode.dependents) {
          if (!transitivelyAffected.has(dependentId)) {
            queue.push(dependentId);
          }
        }
      }
    }

    return {
      directlyAffected,
      transitivelyAffected: Array.from(transitivelyAffected),
    };
  }

  /**
   * Get direct dependencies of a rule
   */
  getDependencies(ruleId: string): string[] {
    const node = this.nodes.get(ruleId);
    return node ? Array.from(node.dependencies) : [];
  }

  /**
   * Get direct dependents of a rule
   */
  getDependents(ruleId: string): string[] {
    const node = this.nodes.get(ruleId);
    return node ? Array.from(node.dependents) : [];
  }

  /**
   * Check if adding a dependency would create a cycle
   */
  wouldCreateCycle(fromRuleId: string, toRuleId: string): boolean {
    // If toRuleId depends on fromRuleId (directly or transitively), adding
    // fromRuleId -> toRuleId would create a cycle
    const visited = new Set<string>();
    const queue = [toRuleId];

    while (queue.length > 0) {
      const currentId = queue.shift()!;
      if (currentId === fromRuleId) return true;
      if (visited.has(currentId)) continue;

      visited.add(currentId);

      const node = this.nodes.get(currentId);
      if (node) {
        for (const depId of node.dependencies) {
          if (!visited.has(depId)) {
            queue.push(depId);
          }
        }
      }
    }

    return false;
  }

  /**
   * Get all rule IDs in the graph
   */
  getAllRuleIds(): string[] {
    return Array.from(this.nodes.keys());
  }

  /**
   * Get the number of rules in the graph
   */
  size(): number {
    return this.nodes.size;
  }

  /**
   * Clear the entire graph
   */
  clear(): void {
    this.nodes.clear();
    this.topologicalOrder = null;
    this.hasChanges = true;
  }

  /**
   * Export graph for debugging/visualization
   */
  toDebugString(): string {
    const lines: string[] = ['Dependency Graph:'];

    for (const [ruleId, node] of this.nodes) {
      const deps = Array.from(node.dependencies).join(', ') || '(none)';
      const dependents = Array.from(node.dependents).join(', ') || '(none)';
      lines.push(`  ${ruleId}:`);
      lines.push(`    depends on: ${deps}`);
      lines.push(`    depended by: ${dependents}`);
    }

    return lines.join('\n');
  }
}

// FACTORY FUNCTION

/**
 * Create a new DependencyTracker from a rules store
 */
export function createDependencyTracker(rulesStore?: ILatticeRulesStore): DependencyTracker {
  const tracker = new DependencyTracker();
  if (rulesStore) {
    tracker.build(rulesStore);
  }
  return tracker;
}
