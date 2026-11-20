import { renderHook } from '@testing-library/react';
import dayjs from 'dayjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CSV_BOM } from '@client/app/utils/csv';

const downloadData = vi.hoisted(() => vi.fn());
vi.mock('@client/app/utils/download', () => ({ downloadData }));

import { useExportToCSV } from './useExportToCSV';

const run = (...args: Parameters<ReturnType<typeof useExportToCSV>>) => {
  const { result } = renderHook(() => useExportToCSV());
  result.current(...args);
};

describe('useExportToCSV', () => {
  beforeEach(() => {
    downloadData.mockClear();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2025, 5, 7, 12));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does nothing for empty data', () => {
    run([]);
    expect(downloadData).not.toHaveBeenCalled();
  });

  it('falls back to the keys of the first transformed row for headers', () => {
    run([{ a: 1 }], { customTransform: row => ({ b: row.a, c: 'x' }) });
    const [content] = downloadData.mock.calls[0];
    expect(content).toBe(`${CSV_BOM}b,c\r\n1,x`);
  });

  it('uses customHeaders to pick and order columns', () => {
    run([{ a: 1, b: 2 }], { customHeaders: ['b', 'a'] });
    expect(downloadData.mock.calls[0][0]).toBe(`${CSV_BOM}b,a\r\n2,1`);
  });

  it('names the file with the current date and sends a BOM-prefixed UTF-8 CSV', () => {
    run([{ a: 1 }], { filename: 'report' });
    const [content, filename, type] = downloadData.mock.calls[0];
    expect(filename).toBe(`report_${dayjs().format('YYYY-MM-DD')}.csv`);
    expect(filename).toBe('report_2025-06-07.csv');
    expect(content.startsWith(CSV_BOM)).toBe(true);
    expect(type).toBe('text/csv;charset=utf-8;');
  });

  it('reformats ISO date string cells with dateFormat', () => {
    run([{ date: '2025-03-04T10:30:00' }], { dateFormat: 'DD/MM/YYYY' });
    expect(downloadData.mock.calls[0][0]).toBe(`${CSV_BOM}date\r\n04/03/2025`);
  });
});
