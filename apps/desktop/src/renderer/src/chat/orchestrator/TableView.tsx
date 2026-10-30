import Box from '@mui/joy/Box';
import Table from '@mui/joy/Table';
import Typography from '@mui/joy/Typography';
import { useMemo, useState } from 'react';
import { timeAgo } from '../prBarModel';
import { activityLabel } from './activity';
import { AgentStateChip } from './AgentStateChip';
import type { OrchestratorViewProps } from './OrchestratorStage';
import { formatAgentCost, type AgentView } from './roster';

type SortKey = 'agent' | 'updated' | 'cost';
interface Sort {
  key: SortKey;
  direction: 'asc' | 'desc';
}

const INDENT_PX = 16;

const COMPARE: Record<SortKey, (a: AgentView, b: AgentView) => number> = {
  agent: (a, b) => a.title.localeCompare(b.title),
  updated: (a, b) => a.updatedAt.localeCompare(b.updatedAt),
  cost: (a, b) => (a.usdCost ?? 0) - (b.usdCost ?? 0),
};

/** Text sorts A-Z first; time and cost lead with the newest and the priciest. */
const FIRST_DIRECTION: Record<SortKey, Sort['direction']> = { agent: 'asc', updated: 'desc', cost: 'desc' };

const clamp = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as const;

function nowText(agent: AgentView): string {
  if (agent.state === 'working' && agent.activity) return activityLabel(agent.activity);
  return agent.lastSnippet || '-';
}

function SortHeader({
  sortKey,
  label,
  sort,
  onSort,
}: {
  sortKey: SortKey;
  label: string;
  sort: Sort | null;
  onSort(key: SortKey): void;
}) {
  const active = sort?.key === sortKey;
  return (
    <th
      aria-sort={active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
      data-testid={`orchestrator-table-sort-${sortKey}`}
      onClick={() => onSort(sortKey)}
      style={{ cursor: 'pointer' }}
    >
      {label}
      {active ? (sort.direction === 'asc' ? ' \u25B2' : ' \u25BC') : ''}
    </th>
  );
}

export function TableView({ agents, onSelect, selectedId }: OrchestratorViewProps) {
  const [sort, setSort] = useState<Sort | null>(null);

  const rows = useMemo(() => {
    if (!sort) return agents;
    const sign = sort.direction === 'asc' ? 1 : -1;
    if (sort.key === 'cost') {
      // Only USD is comparable; credit-only and unknown costs trail in roster order whichever way it runs.
      const priced = agents.filter(agent => agent.usdCost !== undefined);
      const unpriced = agents.filter(agent => agent.usdCost === undefined);
      return [...priced.sort((a, b) => sign * COMPARE.cost(a, b)), ...unpriced];
    }
    return [...agents].sort((a, b) => sign * COMPARE[sort.key](a, b));
  }, [agents, sort]);

  const toggleSort = (key: SortKey) =>
    setSort(current =>
      current?.key === key
        ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
        : { key, direction: FIRST_DIRECTION[key] }
    );

  const now = Date.now();
  return (
    <Box sx={{ overflow: 'auto', flex: 1, minHeight: 0 }}>
      <Table
        stickyHeader
        hoverRow
        size="sm"
        data-testid="orchestrator-table"
        sx={{ tableLayout: 'fixed', minWidth: 760 }}
      >
        <thead>
          <tr>
            <th style={{ width: 96 }}>State</th>
            <SortHeader sortKey="agent" label="Agent" sort={sort} onSort={toggleSort} />
            <th>Now</th>
            <SortHeader sortKey="updated" label="Updated" sort={sort} onSort={toggleSort} />
            <SortHeader sortKey="cost" label="Cost" sort={sort} onSort={toggleSort} />
            <th style={{ width: 96 }}>PR</th>
            <th>Branch</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(agent => (
            <tr
              key={agent.id}
              data-testid={`orchestrator-table-row-${agent.id}`}
              onClick={() => onSelect(agent.id)}
              style={{ cursor: 'pointer' }}
              aria-selected={agent.id === selectedId}
            >
              <td>
                <AgentStateChip state={agent.state} />
              </td>
              <td title={agent.seedPrompt}>
                <Typography level="body-sm" sx={{ ...clamp, pl: `${(agent.depth - 1) * INDENT_PX}px` }}>
                  {agent.title}
                </Typography>
              </td>
              <td>
                <Typography level="body-xs" sx={clamp}>
                  {nowText(agent)}
                </Typography>
              </td>
              <td>{timeAgo(agent.updatedAt, now) ?? '-'}</td>
              <td>{formatAgentCost(agent.usdCost, agent.credits)}</td>
              <td>{agent.pr ? `#${agent.pr.number} ${agent.pr.state}` : '-'}</td>
              <td>
                <Typography level="body-xs" sx={clamp}>
                  {agent.branch ?? '-'}
                </Typography>
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Box>
  );
}
