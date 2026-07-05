/**
 * useLatticeChartData
 *
 * Transforms Lattice model entities into Recharts-compatible data format.
 * Groups entities by period and extracts numeric values for each category.
 */

import { useMemo } from 'react';
import type { ILatticeModel, ILatticeEntity, ILatticeComputedValues } from '@bike4mind/common';

export interface LatticeChartDataPoint {
  period: string;
  [key: string]: string | number;
}

export interface LatticeChartConfig {
  chartType: 'BarChart' | 'LineChart' | 'AreaChart' | 'ComposedChart';
  data: LatticeChartDataPoint[];
  config: {
    xAxis: string;
    yAxis: string[];
    colors?: string[];
    legend?: boolean;
    grid?: boolean;
    tooltip?: boolean;
    responsive?: boolean;
    height?: number;
  };
  title?: string;
  description?: string;
}

export interface UseLatticeChartDataResult {
  chartConfig: LatticeChartConfig | null;
  periods: string[];
  categories: string[];
  hasTimeSeriesData: boolean;
}

/**
 * Extract value from entity attributes, checking computed values first
 */
function getEntityValue(entity: ILatticeEntity, computedValues: ILatticeComputedValues | null): number | null {
  // Check if there's a computed value for this entity's "value" attribute
  const computedEntry = computedValues?.[entity.id]?.['value'];
  if (computedEntry?.value !== undefined && typeof computedEntry.value === 'number') {
    return computedEntry.value;
  }

  // Fall back to raw attribute value
  const valueAttr = entity.attributes.find(attr => attr.key === 'value');
  if (valueAttr && typeof valueAttr.value === 'number') {
    return valueAttr.value;
  }
  return null;
}

/**
 * Extract period from entity attributes
 */
function getEntityPeriod(entity: ILatticeEntity): string | null {
  const periodAttr = entity.attributes.find(attr => attr.key === 'period');
  if (periodAttr && typeof periodAttr.value === 'string') {
    return periodAttr.value;
  }
  return null;
}

/**
 * Extract category from entity attributes
 */
function getEntityCategory(entity: ILatticeEntity): string | null {
  const categoryAttr = entity.attributes.find(attr => attr.key === 'category');
  if (categoryAttr && typeof categoryAttr.value === 'string') {
    return categoryAttr.value;
  }
  return null;
}

/**
 * Sort periods chronologically (Q1, Q2, Q3, Q4)
 */
function sortPeriods(periods: string[]): string[] {
  return periods.sort((a, b) => {
    // Extract quarter and year if present
    const matchA = a.match(/Q(\d)\s*(\d{4})?/i);
    const matchB = b.match(/Q(\d)\s*(\d{4})?/i);

    if (matchA && matchB) {
      const yearA = matchA[2] ? parseInt(matchA[2]) : 0;
      const yearB = matchB[2] ? parseInt(matchB[2]) : 0;

      if (yearA !== yearB) {
        return yearA - yearB;
      }

      return parseInt(matchA[1]) - parseInt(matchB[1]);
    }

    // Fallback to alphabetical sort
    return a.localeCompare(b);
  });
}

// Default financial chart colors
const DEFAULT_COLORS = [
  '#22c55e', // green - revenue/positive
  '#ef4444', // red - costs/negative
  '#f59e0b', // amber - expenses
  '#3b82f6', // blue - profit
  '#8b5cf6', // purple - other
  '#06b6d4', // cyan
];

/**
 * Hook to transform Lattice model data into Recharts-compatible format
 */
export function useLatticeChartData(
  model: ILatticeModel | null,
  computedValues: ILatticeComputedValues | null = null,
  chartType: 'BarChart' | 'LineChart' | 'AreaChart' | 'ComposedChart' = 'BarChart'
): UseLatticeChartDataResult {
  return useMemo(() => {
    if (!model || !model.data?.entities) {
      return {
        chartConfig: null,
        periods: [],
        categories: [],
        hasTimeSeriesData: false,
      };
    }

    const entities = model.data.entities;

    // Group entities by period and category
    const periodMap = new Map<string, Map<string, number>>();
    const allCategories = new Set<string>();
    const allPeriods = new Set<string>();

    for (const entity of entities) {
      const period = getEntityPeriod(entity);
      const category = getEntityCategory(entity);
      const value = getEntityValue(entity, computedValues);

      // Only include entities with period, category, and value
      if (period && category && value !== null) {
        allPeriods.add(period);
        allCategories.add(category);

        if (!periodMap.has(period)) {
          periodMap.set(period, new Map());
        }
        periodMap.get(period)!.set(category, value);
      }
    }

    const periods = sortPeriods(Array.from(allPeriods));
    const categories = Array.from(allCategories);

    // No time series data if we don't have periods
    if (periods.length === 0) {
      return {
        chartConfig: null,
        periods: [],
        categories,
        hasTimeSeriesData: false,
      };
    }

    // Build data points array for Recharts
    const data: LatticeChartDataPoint[] = periods.map(period => {
      const categoryValues = periodMap.get(period) || new Map();
      const dataPoint: LatticeChartDataPoint = { period };

      for (const category of categories) {
        dataPoint[category] = categoryValues.get(category) || 0;
      }

      return dataPoint;
    });

    // Build chart config
    const chartConfig: LatticeChartConfig = {
      chartType,
      data,
      config: {
        xAxis: 'period',
        yAxis: categories,
        colors: DEFAULT_COLORS.slice(0, categories.length),
        legend: true,
        grid: true,
        tooltip: true,
        responsive: true,
        height: 400,
      },
      title: model.name,
      description: model.description,
    };

    return {
      chartConfig,
      periods,
      categories,
      hasTimeSeriesData: true,
    };
  }, [model, computedValues, chartType]);
}

export default useLatticeChartData;
