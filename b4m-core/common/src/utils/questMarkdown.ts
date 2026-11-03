/**
 * Markdown serializers for QuestMaster plans (legacy v4 documents) and v5 graphs. Pure and
 * runtime-agnostic: the in-app export and server-side migrations share them, so nothing here reads
 * the clock or the locale - callers pass both in.
 */
import YAML from 'yaml';
import type { IQuestMasterPlanDocument } from '../types/entities/QuestTypes';
import type { IQuestGraph, IQuestNode } from '../types/entities/QuestNodeTypes';
import { getSubQuestStatusIcon, getSubQuestStatusLabel } from './subQuestStatusPresentation';

export interface QuestMarkdownOptions {
  /** Written into the "Exported from QuestMaster on ..." line, e.g. `2026-10-29`. */
  exportedOn: string;
  /** Renders a timestamp for display. Defaults to ISO 8601 so the output is locale-independent. */
  formatTimestamp?: (value: Date) => string;
  /** Prepend YAML front-matter carrying the structure and the source id. Off by default. */
  frontMatter?: boolean;
}

// toISOString throws on an invalid Date; a corrupt persisted timestamp must not abort a whole export.
const defaultFormatTimestamp = (value: Date): string =>
  Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();

const MAX_HEADING_LEVEL = 6;

const frontMatterBlock = (data: Record<string, unknown>): string =>
  `---\n${YAML.stringify(data, { lineWidth: 0 })}---\n\n`;

// A title or goal is free text; a newline would end a heading early.
const singleLine = (value: string): string => value.replace(/\s+/g, ' ').trim();

export function questPlanToMarkdown(plan: IQuestMasterPlanDocument, options: QuestMarkdownOptions): string {
  const formatTimestamp = options.formatTimestamp ?? defaultFormatTimestamp;
  const totalSubQuests = plan.quests.reduce((sum, q) => sum + q.subQuests.length, 0);
  const completedSubQuests = plan.quests.reduce(
    (sum, q) => sum + q.subQuests.filter(sq => sq.status === 'completed').length,
    0
  );

  let md = '';

  if (options.frontMatter) {
    md += frontMatterBlock({
      source: { kind: 'quest-plan', id: plan.id },
      goal: plan.goal,
      state: plan.state || 'active',
      priority: plan.priority,
      tags: plan.tags ?? [],
      quests: plan.quests.map(q => ({
        id: q.id,
        title: q.title,
        complexity: q.complexity,
        subQuests: q.subQuests.map(sq => ({ id: sq.id, title: sq.title, status: sq.status })),
      })),
    });
  }

  md += `# ${plan.goal}\n\n`;
  md += `> Exported from QuestMaster on ${options.exportedOn}\n`;
  md += `> Status: ${plan.state || 'active'} | Progress: ${completedSubQuests}/${totalSubQuests} tasks`;
  if (plan.metrics?.completionRate !== undefined) {
    md += ` (${plan.metrics.completionRate}%)`;
  }
  md += `\n\n`;

  if (plan.tags && plan.tags.length > 0) {
    md += `> Tags: ${plan.tags.join(', ')}\n\n`;
  }

  md += `---\n\n`;

  md += `## Table of Contents\n\n`;
  plan.quests.forEach((quest, i) => {
    md += `${i + 1}. **${quest.title}** (${quest.complexity})\n`;
    quest.subQuests.forEach((sq, j) => {
      md += `   ${i + 1}.${j + 1}. ${sq.title}${getSubQuestStatusIcon(sq.status)}\n`;
    });
  });
  md += `\n---\n\n`;

  plan.quests.forEach((quest, i) => {
    const completedInQuest = quest.subQuests.filter(sq => sq.status === 'completed').length;
    md += `## Quest ${i + 1}: ${quest.title}\n\n`;
    md += `**Complexity:** ${quest.complexity} | **Progress:** ${completedInQuest}/${quest.subQuests.length}\n\n`;
    md += `${quest.description}\n\n`;

    quest.subQuests.forEach((sq, j) => {
      const icon = getSubQuestStatusIcon(sq.status);
      md += `### ${i + 1}.${j + 1}. ${sq.title}${icon}\n\n`;
      md += `- **Status:** ${getSubQuestStatusLabel(sq.status)}\n`;
      if (sq.startedAt) {
        md += `- **Started:** ${formatTimestamp(new Date(sq.startedAt))}\n`;
      }
      md += `\n`;
    });

    md += `---\n\n`;
  });

  return md;
}

/**
 * Renders a v5 graph as a tree: roots in `rootNodeIds` order, children by `order`. A node that
 * is not reachable from a root (orphaned, or caught in a parent cycle) is still emitted, under
 * "Unattached nodes", so no persisted node is silently dropped from an export.
 */
export function questGraphToMarkdown(graph: IQuestGraph, nodes: IQuestNode[], options: QuestMarkdownOptions): string {
  const formatTimestamp = options.formatTimestamp ?? defaultFormatTimestamp;
  const byId = new Map(nodes.map(node => [node.id, node]));
  const completed = nodes.filter(node => node.status === 'completed').length;

  const childrenOf = new Map<string, IQuestNode[]>();
  for (const node of nodes) {
    if (!node.parentId || !byId.has(node.parentId)) continue;
    const siblings = childrenOf.get(node.parentId) ?? [];
    siblings.push(node);
    childrenOf.set(node.parentId, siblings);
  }
  for (const siblings of childrenOf.values()) siblings.sort((a, b) => a.order - b.order);

  const roots = graph.rootNodeIds.map(id => byId.get(id)).filter((node): node is IQuestNode => node !== undefined);

  let md = '';

  if (options.frontMatter) {
    md += frontMatterBlock({
      source: { kind: 'quest-graph', id: graph.id },
      goal: graph.goal,
      state: graph.state,
      visibility: graph.visibility,
      rootNodeIds: graph.rootNodeIds,
      nodes: nodes.map(node => ({
        id: node.id,
        parentId: node.parentId ?? null,
        dependsOn: node.dependsOn,
        order: node.order,
        kind: node.kind,
        status: node.status,
        title: node.title,
      })),
    });
  }

  md += `# ${singleLine(graph.goal)}\n\n`;
  md += `> Exported from QuestMaster on ${options.exportedOn}\n`;
  md += `> State: ${graph.state} | Progress: ${completed}/${nodes.length} nodes\n\n`;
  md += `---\n\n`;

  const emitted = new Set<string>();

  const renderNode = (node: IQuestNode, level: number): void => {
    if (emitted.has(node.id)) return;
    emitted.add(node.id);

    md += `${'#'.repeat(Math.min(level, MAX_HEADING_LEVEL))} ${singleLine(node.title)}\n\n`;
    md += `- **Status:** ${node.status}\n`;
    md += `- **Kind:** ${node.kind}\n`;
    if (node.dependsOn.length > 0) {
      const names = node.dependsOn.map(id => singleLine(byId.get(id)?.title ?? id));
      md += `- **Depends on:** ${names.join(', ')}\n`;
    }
    if (node.score !== undefined && node.score !== null) md += `- **Score:** ${node.score}\n`;
    if (node.reviewVerdict) md += `- **Review:** ${node.reviewVerdict}\n`;
    if (node.startedAt) md += `- **Started:** ${formatTimestamp(new Date(node.startedAt))}\n`;
    if (node.completedAt) md += `- **Completed:** ${formatTimestamp(new Date(node.completedAt))}\n`;
    md += `\n${node.task}\n\n`;
    if (node.acceptanceCriteria) md += `**Acceptance criteria:** ${node.acceptanceCriteria}\n\n`;

    for (const child of childrenOf.get(node.id) ?? []) renderNode(child, level + 1);
  };

  roots.forEach(root => renderNode(root, 2));

  const unattached = nodes.filter(node => !emitted.has(node.id)).sort((a, b) => a.order - b.order);
  if (unattached.length > 0) {
    md += `## Unattached nodes\n\n`;
    unattached.forEach(node => renderNode(node, 3));
  }

  return md;
}
