import React from 'react';
import { StatStrip, StatTile } from '../../shared';
import type { EventMetric } from '../types';

/** The loaded events' key numbers, shared by the event and Slack metrics pages. */
export const EventMetricsStats: React.FC<{ metrics: EventMetric[]; filteredMetrics: EventMetric[] }> = ({
  metrics,
  filteredMetrics,
}) => {
  const uniqueEvents = React.useMemo(() => new Set(metrics.map(m => m.eventName)).size, [metrics]);
  const uniqueUsers = React.useMemo(() => new Set(metrics.map(m => m.user.userId)).size, [metrics]);

  return (
    <StatStrip aria-label="Event totals">
      <StatTile label="Total events" value={metrics.length} />
      <StatTile label="Filtered" value={filteredMetrics.length} />
      <StatTile label="Unique events" value={uniqueEvents} />
      <StatTile label="Unique users" value={uniqueUsers} />
    </StatStrip>
  );
};
