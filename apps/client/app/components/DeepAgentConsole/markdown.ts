import type { Episode } from '@bike4mind/agents';
import type { AgentDetail } from '@client/app/hooks/data/deepAgents';

/**
 * Render an agent's full dossier as shareable GitHub-flavored markdown -
 * identity, goal, drives, memory with provenance, blockers, and the episode
 * timeline with verdicts and scope locks. Pure function; the console's
 * "Copy MD" button feeds it to the clipboard.
 */

function formatEpisode(episode: Episode): string {
  const lines: string[] = [];
  const when = new Date(episode.wakeAt).toLocaleString();
  const tok = episode.tokensSpent > 0 ? ` · ${episode.tokensSpent.toLocaleString()} tok` : '';
  const reviewed = episode.reviewedByEpisodeId
    ? ` · reviewed ✓ (by \`${episode.reviewedByEpisodeId.slice(0, 8)}…\`)`
    : '';
  lines.push(`### ${when} — \`${episode.policyDecision.actionKind}\` (${episode.evidenceTier}${tok})${reviewed}`);
  lines.push('');
  lines.push(`> ${episode.policyDecision.rationale}`);

  const tools = episode.actionsTaken.map(a => a.tool);
  if (tools.length > 0) {
    lines.push('');
    lines.push(`**Tools:** ${tools.map(t => `\`${t}\``).join(', ')}`);
  }

  const verdict = episode.observations.find(o => o.kind === 'review_verdict')?.summary;
  if (verdict) {
    lines.push('');
    lines.push(`**⚖️ Verdict:** ${verdict}`);
    const issues = episode.observations.filter(o => o.kind === 'review_issue');
    for (const issue of issues) lines.push(`- ⚠️ ${issue.summary}`);
  }

  const finalAnswer = episode.observations.find(o => o.kind === 'final_answer')?.summary;
  if (finalAnswer) {
    lines.push('');
    lines.push(finalAnswer);
  }

  if (episode.reflection && episode.reflection !== verdict) {
    lines.push('');
    lines.push(`**Reflection:** ${episode.reflection}`);
  }

  if (episode.scopeLocks.length > 0) {
    lines.push('');
    lines.push('**Scope locks:**');
    for (const lock of episode.scopeLocks) lines.push(`- 🔒 ${lock}`);
  }

  return lines.join('\n');
}

export function formatAgentDossierMarkdown(detail: AgentDetail): string {
  const { charter, handoff, episodes } = detail;
  const lines: string[] = [];

  lines.push(`# ${charter.identity.name} — Deep Agent Dossier`);
  lines.push('');
  const wakes = handoff ? `${handoff.wakeCount} wake${handoff.wakeCount === 1 ? '' : 's'}` : 'no wakes yet';
  lines.push(
    `**Role:** ${charter.identity.role} · **Tier:** ${charter.currentTier} · **v${charter.version}** · ${wakes}`
  );
  lines.push('');
  lines.push(`**Goal:** ${charter.goal.description}`);

  if (handoff?.nextIntendedAction) {
    lines.push('');
    lines.push(`**Next intended action:** ${handoff.nextIntendedAction}`);
  }

  lines.push('');
  lines.push('## Drives');
  lines.push('');
  lines.push(
    (Object.entries(charter.drives) as Array<[string, number]>)
      .map(([key, value]) => `${key} ${value.toFixed(2)}`)
      .join(' · ')
  );

  lines.push('');
  lines.push(`## Semantic memory (${charter.semanticMemory.length})`);
  lines.push('');
  if (charter.semanticMemory.length === 0) {
    lines.push('_(nothing groomed into long-term memory yet)_');
  } else {
    for (const m of charter.semanticMemory) {
      const provenance =
        m.sourceEpisodeIds.length > 0 ? ` · from episode \`${m.sourceEpisodeIds[0].slice(0, 8)}…\`` : '';
      lines.push(`- ${m.fact}`);
      lines.push(`  — _${m.evidenceTier} · conf ${m.confidence.toFixed(2)}${provenance}_`);
    }
  }

  if (charter.blockers.length > 0) {
    lines.push('');
    lines.push('## Blockers');
    lines.push('');
    for (const b of charter.blockers) lines.push(`- 🚧 ${b}`);
  }

  lines.push('');
  lines.push(`## Episodes (${episodes.length}, newest first)`);
  for (const episode of episodes) {
    lines.push('');
    lines.push(formatEpisode(episode));
  }

  lines.push('');
  lines.push(`_Exported from the B4M Deep Agent Console · agent \`${charter.identity.agentId}\`_`);
  return lines.join('\n');
}
