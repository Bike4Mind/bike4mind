import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import RechartsChart from './RechartsChart';

const hostileRow = {
  name: 'Jan',
  value: 10,
  dangerouslySetInnerHTML: { __html: '<img data-testid="injected" src="x">' },
};

describe('RechartsChart', () => {
  it.each(['BarChart', 'PieChart', 'ScatterChart', 'RadialBarChart', 'FunnelChart'])(
    'never puts row-supplied markup into the %s DOM',
    chartType => {
      const { container } = render(
        <RechartsChart
          config={{
            chartType,
            data: [hostileRow, { ...hostileRow, name: 'Feb', value: 20 }],
            config: { xAxis: 'name', yAxis: 'value', responsive: false, width: 400, height: 300 },
          }}
        />
      );
      expect(container.querySelector('svg')).not.toBeNull();
      expect(container.querySelector('[data-testid="injected"]')).toBeNull();
      expect(container.innerHTML).not.toContain('injected');
    }
  );
});
