import { useMemo, useState } from 'react';
import { Box, Link, Typography } from '@mui/joy';
import type { Theme } from '@mui/joy/styles';
import { alpha } from '@mui/system';

export interface ScopeEndpointGroup {
  /** `/api/<resource>` or `/api/v1/<resource>`; for a prose entry, the entry itself. */
  prefix: string;
  endpoints: string[];
}

const ENDPOINT_PATH = /^[A-Z|]+ (\/api\/(?:v1\/)?[^/\s]+)/;

/** `endpoints` grouped by the resource they sit under, groups and entries sorted by path. */
export function groupScopeEndpoints(endpoints: readonly string[]): ScopeEndpointGroup[] {
  const groups = new Map<string, string[]>();
  for (const endpoint of endpoints) {
    const prefix = ENDPOINT_PATH.exec(endpoint)?.[1] ?? endpoint;
    groups.set(prefix, [...(groups.get(prefix) ?? []), endpoint]);
  }
  const byPath = (a: string, b: string) => a.replace(/^\S+ /, '').localeCompare(b.replace(/^\S+ /, ''));
  return [...groups]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([prefix, entries]) => ({ prefix, endpoints: [...entries].sort(byPath) }));
}

const summarize = ({ prefix, endpoints }: ScopeEndpointGroup) =>
  endpoints.length === 1 ? endpoints[0] : `${prefix}/* (${endpoints.length} routes)`;

/**
 * A scope's endpoints for the Scopes docs tab: one summary line per resource, expandable to every
 * route. Lists are generated from the routes themselves, so a broad scope can run to dozens.
 */
export function ScopeEndpointList({ scope, endpoints }: { scope: string; endpoints: readonly string[] }) {
  const [expanded, setExpanded] = useState(false);
  const groups = useMemo(() => groupScopeEndpoints(endpoints), [endpoints]);
  if (endpoints.length === 0) return null;
  const collapsible = groups.some(g => g.endpoints.length > 1);
  const muted = { color: (theme: Theme) => alpha(theme.palette.text.primary, 0.5) };

  return (
    <Box data-testid={`api-keys-scope-endpoints-${scope}`}>
      <Typography level="body-xs" sx={muted}>
        <strong>Endpoints:</strong> {groups.map(summarize).join(', ')}
        {collapsible && (
          <>
            {' '}
            <Link
              component="button"
              level="body-xs"
              onClick={() => setExpanded(open => !open)}
              data-testid={`api-keys-scope-endpoints-${scope}-toggle-btn`}
            >
              {expanded ? 'Hide routes' : `Show all ${endpoints.length}`}
            </Link>
          </>
        )}
      </Typography>
      {expanded && (
        <Box
          component="ul"
          data-testid={`api-keys-scope-endpoints-${scope}-list`}
          sx={{ m: 0, mt: 0.5, pl: 2.5, fontFamily: 'code', fontSize: '12px', ...muted }}
        >
          {groups
            .flatMap(g => g.endpoints)
            .map(endpoint => (
              <li key={endpoint}>{endpoint}</li>
            ))}
        </Box>
      )}
    </Box>
  );
}
