/**
 * LatticeTableView
 *
 * Renders a Lattice model as an editable spreadsheet-like table.
 * Rows are entities, columns are periods/attributes.
 */

import React, { useState, useMemo, useCallback } from 'react';
import { Box, Table, Input, Typography, Tooltip } from '@mui/joy';
import { Theme, useTheme } from '@mui/joy/styles';
import type {
  ILatticeModel,
  ILatticeEntity,
  ILatticeComputedValues,
  ILatticeAttribute,
  PrimitiveValue,
} from '@bike4mind/common';

// Types

export interface LatticeTableViewProps {
  /** The Lattice model to display */
  model: ILatticeModel;
  /** Computed values from hydration */
  computedValues: ILatticeComputedValues | null;
  /** Whether cells are editable */
  editable?: boolean;
  /** Callback when a value changes */
  onValueChange?: (entityId: string, attributeKey: string, value: PrimitiveValue) => void;
}

interface CellValue {
  raw: PrimitiveValue;
  computed: number | null;
  isComputed: boolean;
  dataType: string;
}

// Helpers

/**
 * Format a number for display
 */
const formatNumber = (value: number | null | undefined, format?: string): string => {
  if (value === null || value === undefined) return '-';

  if (format === 'currency') {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(value);
  }

  if (format === 'percent') {
    return new Intl.NumberFormat('en-US', {
      style: 'percent',
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    }).format(value / 100);
  }

  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(value);
};

/**
 * Parse user input to a value
 */
const parseValue = (input: string): PrimitiveValue => {
  if (!input || input.trim() === '' || input === '-') return null;

  // Remove currency symbols, commas, and percent signs
  const cleaned = input.replace(/[$,%]/g, '').replace(/,/g, '').trim();
  const parsed = parseFloat(cleaned);

  return isNaN(parsed) ? input : parsed;
};

/**
 * Get column headers from model entities' attributes
 */
const getColumnHeaders = (model: ILatticeModel): string[] => {
  // Collect all unique attribute keys from entities
  const allKeys = new Set<string>();
  model.data.entities.forEach(entity => {
    entity.attributes.forEach(attr => allKeys.add(attr.key));
  });

  return Array.from(allKeys).sort();
};

/**
 * Get attribute value from entity by key
 */
const getAttributeValue = (entity: ILatticeEntity, key: string): ILatticeAttribute | undefined => {
  return entity.attributes.find(attr => attr.key === key);
};

/**
 * Get entity description from metadata
 */
const getEntityDescription = (entity: ILatticeEntity): string | undefined => {
  return entity.metadata?.description as string | undefined;
};

/**
 * Get entity format from metadata
 */
const getEntityFormat = (entity: ILatticeEntity): string | undefined => {
  return entity.metadata?.format as string | undefined;
};

// Component

const LatticeTableView: React.FC<LatticeTableViewProps> = ({
  model,
  computedValues,
  editable = true,
  onValueChange,
}) => {
  const theme = useTheme();
  const [editingCell, setEditingCell] = useState<{ entityId: string; key: string } | null>(null);
  const [editValue, setEditValue] = useState<string>('');

  const columns = useMemo(() => getColumnHeaders(model), [model]);

  // Group entities by type for row grouping
  const groupedEntities = useMemo(() => {
    const groups: Record<string, ILatticeEntity[]> = {};

    model.data.entities.forEach(entity => {
      const type = entity.type || 'default';
      if (!groups[type]) groups[type] = [];
      groups[type].push(entity);
    });

    return groups;
  }, [model.data.entities]);

  const getCellValue = useCallback(
    (entity: ILatticeEntity, key: string): CellValue => {
      const attribute = getAttributeValue(entity, key);
      const rawValue = attribute?.value ?? null;

      // ILatticeComputedValues structure: { [entityId]: { [attributeKey]: { value, computedByRuleId, computedAt } } }
      const entityComputedValues = computedValues?.[entity.id];
      const computedEntry = entityComputedValues?.[key];
      const computedValue = computedEntry?.value ?? null;

      const isComputed = attribute?.isComputed === true || computedValue !== null;

      return {
        raw: rawValue,
        computed: typeof computedValue === 'number' ? computedValue : null,
        isComputed,
        dataType: attribute?.dataType || 'number',
      };
    },
    [computedValues]
  );

  const handleCellClick = useCallback(
    (entityId: string, key: string, currentValue: CellValue) => {
      if (!editable || currentValue.isComputed) return;

      setEditingCell({ entityId, key });
      setEditValue(currentValue.raw !== null ? String(currentValue.raw) : '');
    },
    [editable]
  );

  // Handle cell blur (save)
  const handleCellBlur = useCallback(() => {
    if (!editingCell) return;

    const newValue = parseValue(editValue);
    onValueChange?.(editingCell.entityId, editingCell.key, newValue);

    setEditingCell(null);
    setEditValue('');
  }, [editingCell, editValue, onValueChange]);

  const handleKeyPress = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        handleCellBlur();
      } else if (e.key === 'Escape') {
        setEditingCell(null);
        setEditValue('');
      }
    },
    [handleCellBlur]
  );

  if (model.data.entities.length === 0) {
    return (
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          height: '100%',
          minHeight: 100,
        }}
      >
        <Typography level="body-lg" sx={{ color: 'text.tertiary' }}>
          No entities in this model. Add line items using natural language.
        </Typography>
      </Box>
    );
  }

  return (
    <Box
      className="lattice-table-view"
      sx={{
        width: '100%',
        height: '100%',
        overflow: 'auto',
      }}
    >
      <Table
        stickyHeader
        hoverRow
        sx={(theme: Theme) => ({
          '--TableCell-paddingX': '8px',
          '--TableCell-paddingY': '6px',
          '& th': {
            fontWeight: 'lg',
            bgcolor: theme.palette.background.level1,
          },
          '& td': {
            borderBottom: '1px solid',
            borderColor: theme.palette.divider,
          },
          // First column (row labels)
          '& td:first-of-type, & th:first-of-type': {
            position: 'sticky',
            left: 0,
            bgcolor: theme.palette.background.surface,
            zIndex: 1,
            minWidth: 150,
          },
        })}
      >
        <thead>
          <tr>
            <th>Line Item</th>
            {columns.map(col => (
              <th key={col} style={{ textAlign: 'right', minWidth: 100 }}>
                {col}
              </th>
            ))}
          </tr>
        </thead>

        <tbody>
          {Object.entries(groupedEntities).map(([type, entities]) => (
            <React.Fragment key={type}>
              {/* Group header row (if multiple types) */}
              {Object.keys(groupedEntities).length > 1 && (
                <tr>
                  <td
                    colSpan={columns.length + 1}
                    style={{
                      backgroundColor: theme.palette.background.level2,
                      fontWeight: 'bold',
                      fontSize: '0.85rem',
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                    }}
                  >
                    {type}
                  </td>
                </tr>
              )}

              {/* Entity rows */}
              {entities.map(entity => {
                const entityDescription = getEntityDescription(entity);
                const entityFormat = getEntityFormat(entity);
                // Check metadata for summary indicator since LatticeEntityType doesn't include subtotal/total
                const isSummaryRow = entity.metadata?.isSummary === true || entity.metadata?.isTotal === true;

                return (
                  <tr key={entity.id}>
                    {/* Row label */}
                    <td>
                      <Tooltip title={entityDescription || entity.name} placement="right">
                        <Typography
                          level="body-sm"
                          fontWeight={isSummaryRow ? 'lg' : 'md'}
                          sx={{
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            maxWidth: 200,
                          }}
                        >
                          {entity.displayName || entity.name}
                        </Typography>
                      </Tooltip>
                    </td>

                    {/* Value cells */}
                    {columns.map(col => {
                      const cellValue = getCellValue(entity, col);
                      const isEditing = editingCell?.entityId === entity.id && editingCell?.key === col;

                      return (
                        <td
                          key={col}
                          onClick={() => handleCellClick(entity.id, col, cellValue)}
                          style={{
                            textAlign: 'right',
                            cursor: editable && !cellValue.isComputed ? 'pointer' : 'default',
                            backgroundColor: cellValue.isComputed ? theme.palette.primary.softBg : undefined,
                          }}
                        >
                          {isEditing ? (
                            <Input
                              autoFocus
                              size="sm"
                              variant="soft"
                              value={editValue}
                              onChange={e => setEditValue(e.target.value)}
                              onBlur={handleCellBlur}
                              onKeyDown={handleKeyPress}
                              sx={{
                                '--Input-minHeight': '24px',
                                fontSize: '0.85rem',
                                textAlign: 'right',
                              }}
                            />
                          ) : (
                            <Typography
                              level="body-sm"
                              fontFamily="monospace"
                              sx={{
                                color: cellValue.isComputed
                                  ? 'primary.plainColor'
                                  : cellValue.raw === null
                                    ? 'text.tertiary'
                                    : 'text.primary',
                              }}
                            >
                              {formatNumber(
                                cellValue.isComputed
                                  ? cellValue.computed
                                  : typeof cellValue.raw === 'number'
                                    ? cellValue.raw
                                    : null,
                                entityFormat
                              )}
                            </Typography>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </React.Fragment>
          ))}
        </tbody>
      </Table>
    </Box>
  );
};

export default LatticeTableView;
