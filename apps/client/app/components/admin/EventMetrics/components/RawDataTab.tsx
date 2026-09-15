import React from 'react';
import { Box, Table, Sheet, IconButton, Typography, Chip } from '@mui/joy';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import dayjs from 'dayjs';
import type { EventMetric, SortField, SortDirection } from '../types';

interface RawDataTabProps {
  metrics: EventMetric[];
  sortField: SortField;
  sortDirection: SortDirection;
  onSort: (field: SortField) => void;
}

export const RawDataTab: React.FC<RawDataTabProps> = ({ metrics, sortField, sortDirection, onSort }) => {
  const SortIcon = sortDirection === 'asc' ? ArrowUpwardIcon : ArrowDownwardIcon;

  const renderSortButton = (field: SortField, label: string) => (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
      {label}
      <IconButton
        size="sm"
        variant={sortField === field ? 'solid' : 'plain'}
        onClick={() => onSort(field)}
        data-testid={`sort-${field}-btn`}
      >
        {sortField === field && <SortIcon fontSize="small" />}
      </IconButton>
    </Box>
  );

  return (
    <Box>
      <Sheet sx={{ overflow: 'auto', maxHeight: '70vh' }}>
        <Table stripe="odd" hoverRow stickyHeader>
          <thead>
            <tr>
              <th>{renderSortButton('timestamp', 'Timestamp')}</th>
              <th>{renderSortButton('eventCategory', 'Category')}</th>
              <th>{renderSortButton('eventName', 'Event Name')}</th>
              <th>{renderSortButton('userName', 'User')}</th>
              <th>{renderSortButton('counterValue', 'Value')}</th>
              <th>Metadata</th>
            </tr>
          </thead>
          <tbody>
            {metrics.map(metric => (
              <tr key={metric.id}>
                <td>
                  <Typography level="body-xs">{dayjs(metric.timestamp).format('YYYY-MM-DD HH:mm:ss')}</Typography>
                </td>
                <td>
                  <Chip size="sm" color="primary" variant="soft">
                    {metric.eventCategory}
                  </Chip>
                </td>
                <td>
                  <Typography level="body-sm" sx={{ fontFamily: 'monospace' }}>
                    {metric.eventName}
                  </Typography>
                </td>
                <td>
                  <Typography level="body-sm">{metric.user.userName}</Typography>
                  <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                    {metric.user.userLevel}
                  </Typography>
                </td>
                <td>
                  <Typography level="body-sm">{metric.counterValue}</Typography>
                </td>
                <td>
                  {metric.metadata && Object.keys(metric.metadata).length > 0 ? (
                    <Box sx={{ maxWidth: 300, overflow: 'hidden' }}>
                      <Typography level="body-xs" sx={{ fontFamily: 'monospace', whiteSpace: 'pre-wrap' }}>
                        {JSON.stringify(metric.metadata, null, 2).substring(0, 200)}
                        {JSON.stringify(metric.metadata).length > 200 && '...'}
                      </Typography>
                    </Box>
                  ) : (
                    <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                      -
                    </Typography>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Sheet>

      {metrics.length === 0 && (
        <Box sx={{ p: 4, textAlign: 'center' }}>
          <Typography level="h4">No events found</Typography>
          <Typography sx={{ mt: 1 }}>Try adjusting your filters</Typography>
        </Box>
      )}
    </Box>
  );
};
