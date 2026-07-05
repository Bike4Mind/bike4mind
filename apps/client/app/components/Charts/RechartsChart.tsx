import React, { useMemo } from 'react';
import {
  LineChart,
  Line,
  AreaChart,
  Area,
  BarChart,
  Bar,
  PieChart,
  Pie,
  ScatterChart,
  Scatter,
  RadialBarChart,
  RadialBar,
  ComposedChart,
  RadarChart,
  Radar,
  Treemap,
  FunnelChart,
  Funnel,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  Cell,
} from 'recharts';
import { Box, Typography, Alert } from '@mui/joy';

interface RechartsChartProps {
  config: {
    chartType: string;
    data: Array<Record<string, any>>;
    config: {
      xAxis?: string;
      yAxis?: string | string[]; // Support both single value and array
      width?: number;
      height?: number;
      colors?: string[];
      legend?: boolean;
      grid?: boolean;
      tooltip?: boolean;
      responsive?: boolean;
      // ComposedChart specific configuration
      axes?: {
        x?: { dataKey: string; label?: string };
        y?: Array<{ dataKey: string; label?: string; orientation?: 'left' | 'right' }>;
      };
      children?: Array<{
        type: 'Bar' | 'Line' | 'Area';
        dataKey: string;
        fill?: string;
        stroke?: string;
        name?: string;
        [key: string]: any;
      }>;
    };
  };
  title?: string;
  description?: string;
}

const RechartsChart: React.FC<RechartsChartProps> = ({ config, title, description }) => {
  const { chartType, data, config: chartConfig = {} } = config;
  const {
    xAxis,
    yAxis,
    width = 600,
    height = 400,
    colors = ['#8884d8', '#82ca9d', '#ffc658', '#ff7c7c', '#8dd1e1'],
    legend = true,
    grid = true,
    tooltip = true,
    responsive = true,
    axes: axesConfig,
    children: childrenConfig,
  } = chartConfig;

  const chartComponent = useMemo(() => {
    const commonProps = {
      width: responsive ? undefined : width,
      height: responsive ? undefined : height,
      data,
      margin: { top: 20, right: 30, left: 20, bottom: 20 },
    };

    // Normalize yAxis to always be an array for easier processing
    // Handle case where yAxis might be a stringified array
    let normalizedYAxis = yAxis;
    if (typeof yAxis === 'string' && yAxis.startsWith('[')) {
      try {
        normalizedYAxis = JSON.parse(yAxis);
      } catch (e) {
        console.warn('Failed to parse yAxis as JSON array:', e);
        normalizedYAxis = yAxis;
      }
    }
    const yAxisArray = Array.isArray(normalizedYAxis) ? normalizedYAxis : normalizedYAxis ? [normalizedYAxis] : [];
    // For single-value chart types, use the first value or default
    const yAxisSingle = yAxisArray[0] || 'value';

    const renderChart = () => {
      switch (chartType) {
        case 'LineChart':
          return (
            <LineChart {...commonProps}>
              {grid && <CartesianGrid strokeDasharray="3 3" />}
              <XAxis dataKey={xAxis} />
              <YAxis />
              {tooltip && <Tooltip />}
              {legend && <Legend />}
              {yAxisArray.map((dataKey, index) => (
                <Line
                  key={dataKey}
                  type="monotone"
                  dataKey={dataKey}
                  stroke={colors[index % colors.length]}
                  strokeWidth={2}
                  dot={{ fill: colors[index % colors.length] }}
                />
              ))}
            </LineChart>
          );

        case 'AreaChart':
          return (
            <AreaChart {...commonProps}>
              {grid && <CartesianGrid strokeDasharray="3 3" />}
              <XAxis dataKey={xAxis} />
              <YAxis />
              {tooltip && <Tooltip />}
              {legend && <Legend />}
              {yAxisArray.map((dataKey, index) => (
                <Area
                  key={dataKey}
                  type="monotone"
                  dataKey={dataKey}
                  stroke={colors[index % colors.length]}
                  fill={colors[index % colors.length]}
                  fillOpacity={0.6}
                />
              ))}
            </AreaChart>
          );

        case 'BarChart':
          return (
            <BarChart {...commonProps}>
              {grid && <CartesianGrid strokeDasharray="3 3" />}
              <XAxis dataKey={xAxis} />
              <YAxis />
              {tooltip && <Tooltip />}
              {legend && <Legend />}
              {yAxisArray.map((dataKey, index) => (
                <Bar key={dataKey} dataKey={dataKey} fill={colors[index % colors.length]} />
              ))}
            </BarChart>
          );

        case 'PieChart': {
          // For PieChart, try to auto-detect fields if not specified or if they don't exist in data
          const pieNameKey =
            xAxis && data[0]?.[xAxis] !== undefined
              ? xAxis
              : Object.keys(data[0] || {}).find(key => typeof data[0][key] === 'string') || 'name';
          const pieValueKey =
            yAxisSingle && data[0]?.[yAxisSingle] !== undefined
              ? yAxisSingle
              : Object.keys(data[0] || {}).find(key => typeof data[0][key] === 'number') || 'value';

          return (
            <PieChart {...commonProps}>
              {tooltip && <Tooltip />}
              {legend && <Legend />}
              <Pie
                data={data}
                dataKey={pieValueKey}
                nameKey={pieNameKey}
                cx="50%"
                cy="50%"
                outerRadius={Math.min(width, height) * 0.3}
                fill={colors[0]}
                label
              >
                {data.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={colors[index % colors.length]} />
                ))}
              </Pie>
            </PieChart>
          );
        }

        case 'ScatterChart':
          return (
            <ScatterChart {...commonProps}>
              {grid && <CartesianGrid strokeDasharray="3 3" />}
              <XAxis dataKey={xAxis} />
              <YAxis dataKey={yAxisSingle} />
              {tooltip && <Tooltip />}
              {legend && <Legend />}
              <Scatter name="Data" data={data} fill={colors[0]} />
            </ScatterChart>
          );

        case 'RadialBarChart': {
          // For RadialBarChart, try to auto-detect fields if not specified or if they don't exist in data
          const radialNameKey =
            xAxis && data[0]?.[xAxis] !== undefined
              ? xAxis
              : Object.keys(data[0] || {}).find(key => typeof data[0][key] === 'string') || 'name';
          const radialValueKey =
            yAxisSingle && data[0]?.[yAxisSingle] !== undefined
              ? yAxisSingle
              : Object.keys(data[0] || {}).find(key => typeof data[0][key] === 'number') || 'value';

          // Transform data for RadialBarChart - ensure each item has 'name' and 'fill' field
          const radialData = data.map((item, index) => ({
            ...item,
            name: item[radialNameKey] || item.name || `Item ${index + 1}`,
            fill: colors[index % colors.length],
          }));

          return (
            <RadialBarChart {...commonProps} data={radialData} innerRadius={20} outerRadius={140} barSize={10}>
              <RadialBar
                background
                dataKey={radialValueKey}
                cornerRadius={10}
                label={{ position: 'right', fill: '#fff', fontSize: 11 }}
              >
                {radialData.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={colors[index % colors.length]} />
                ))}
              </RadialBar>
              {tooltip && <Tooltip />}
              {legend && (
                <Legend
                  content={({ payload }) => (
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'center',
                        flexWrap: 'wrap',
                        gap: '16px',
                        marginTop: '16px',
                      }}
                    >
                      {radialData.map((item, index) => (
                        <div key={index} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <div
                            style={{ width: '12px', height: '12px', backgroundColor: colors[index % colors.length] }}
                          />
                          <span style={{ fontSize: '14px' }}>{item.name}</span>
                        </div>
                      ))}
                    </div>
                  )}
                />
              )}
            </RadialBarChart>
          );
        }

        case 'ComposedChart': {
          // Handle complex ComposedChart configuration from artifacts

          return (
            <ComposedChart {...commonProps}>
              {grid && <CartesianGrid strokeDasharray="3 3" />}

              {/* X-Axis */}
              <XAxis dataKey={axesConfig?.x?.dataKey || xAxis} label={axesConfig?.x?.label} />

              {/* Y-Axes */}
              {axesConfig?.y && Array.isArray(axesConfig.y) ? (
                // Multiple Y-axes
                axesConfig.y.map((yAxisConfig, index) => (
                  <YAxis
                    key={yAxisConfig.dataKey || index}
                    yAxisId={yAxisConfig.orientation === 'right' ? 'right' : 'left'}
                    orientation={yAxisConfig.orientation || 'left'}
                    label={yAxisConfig.label}
                  />
                ))
              ) : (
                // Single Y-axis
                <YAxis />
              )}

              {tooltip && <Tooltip />}
              {legend && <Legend />}

              {/* Render chart elements based on children configuration */}
              {childrenConfig && Array.isArray(childrenConfig)
                ? childrenConfig.map((child, index) => {
                    const { type, dataKey, ...props } = child;

                    switch (type) {
                      case 'Bar':
                        return (
                          <Bar
                            key={`${type}-${dataKey}-${index}`}
                            yAxisId={
                              axesConfig?.y?.find(y => y.dataKey === dataKey)?.orientation === 'right'
                                ? 'right'
                                : 'left'
                            }
                            dataKey={dataKey}
                            {...props}
                          />
                        );
                      case 'Line':
                        return (
                          <Line
                            key={`${type}-${dataKey}-${index}`}
                            yAxisId={
                              axesConfig?.y?.find(y => y.dataKey === dataKey)?.orientation === 'right'
                                ? 'right'
                                : 'left'
                            }
                            dataKey={dataKey}
                            type="monotone"
                            {...props}
                          />
                        );
                      case 'Area':
                        return (
                          <Area
                            key={`${type}-${dataKey}-${index}`}
                            yAxisId={
                              axesConfig?.y?.find(y => y.dataKey === dataKey)?.orientation === 'right'
                                ? 'right'
                                : 'left'
                            }
                            dataKey={dataKey}
                            type="monotone"
                            {...props}
                          />
                        );
                      default:
                        return null;
                    }
                  })
                : // Fallback: render all yAxisArray elements as both Bar and Line
                  yAxisArray.map((dataKey, index) => (
                    <React.Fragment key={dataKey}>
                      <Bar dataKey={dataKey} fill={colors[index % colors.length]} />
                      <Line type="monotone" dataKey={dataKey} stroke={colors[index % colors.length]} />
                    </React.Fragment>
                  ))}
            </ComposedChart>
          );
        }

        case 'RadarChart':
          return (
            <RadarChart {...commonProps}>
              <PolarGrid />
              <PolarAngleAxis dataKey={xAxis} />
              <PolarRadiusAxis />
              {tooltip && <Tooltip />}
              {legend && <Legend />}
              {yAxisArray.map((dataKey, index) => (
                <Radar
                  key={dataKey}
                  name={dataKey}
                  dataKey={dataKey}
                  stroke={colors[index % colors.length]}
                  fill={colors[index % colors.length]}
                  fillOpacity={0.6}
                />
              ))}
            </RadarChart>
          );

        case 'Treemap':
          return (
            <Treemap {...commonProps} dataKey={yAxisSingle} aspectRatio={4 / 3}>
              {tooltip && <Tooltip />}
            </Treemap>
          );

        case 'FunnelChart': {
          // For FunnelChart, try to auto-detect fields if not specified or if they don't exist in data
          const funnelNameKey =
            xAxis && data[0]?.[xAxis] !== undefined
              ? xAxis
              : Object.keys(data[0] || {}).find(key => typeof data[0][key] === 'string') || 'name';
          const funnelValueKey =
            yAxisSingle && data[0]?.[yAxisSingle] !== undefined
              ? yAxisSingle
              : Object.keys(data[0] || {}).find(key => typeof data[0][key] === 'number') || 'value';

          return (
            <FunnelChart {...commonProps}>
              {tooltip && <Tooltip />}
              {legend && <Legend />}
              <Funnel dataKey={funnelValueKey} data={data} nameKey={funnelNameKey}>
                {data.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={colors[index % colors.length]} />
                ))}
              </Funnel>
            </FunnelChart>
          );
        }

        default:
          return (
            <Alert color="warning" sx={{ m: 2 }}>
              <Typography>Unsupported chart type: {chartType}</Typography>
            </Alert>
          );
      }
    };

    if (responsive) {
      return (
        <ResponsiveContainer width="100%" height={height}>
          {renderChart()}
        </ResponsiveContainer>
      );
    }

    return renderChart();
  }, [
    chartType,
    data,
    xAxis,
    yAxis,
    width,
    height,
    colors,
    legend,
    grid,
    tooltip,
    responsive,
    axesConfig,
    childrenConfig,
  ]);

  if (!data || data.length === 0) {
    return (
      <Alert color="warning" sx={{ m: 2 }}>
        <Typography>No data available for chart</Typography>
      </Alert>
    );
  }

  return (
    <Box sx={{ width: '100%', p: 2 }}>
      {title && (
        <Typography level="h4" sx={{ mb: 1, textAlign: 'center', width: '100%' }}>
          {title}
        </Typography>
      )}
      <Box sx={{ width: '100%' }}>
        {description && (
          <Typography
            level="body-md"
            sx={{
              mb: 2,
              textAlign: 'left',
              color: 'text.secondary',
              display: 'block',
              width: '100%',
              boxSizing: 'border-box',
              overflow: 'hidden',
              wordBreak: 'break-word',
              overflowWrap: 'break-word',
              whiteSpace: 'pre-wrap',
            }}
          >
            {description}
          </Typography>
        )}
      </Box>
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          minHeight: responsive ? height : 'auto',
          width: '100%',
        }}
      >
        {chartComponent}
      </Box>
    </Box>
  );
};

export default RechartsChart;
