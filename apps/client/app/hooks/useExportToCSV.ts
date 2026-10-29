import { useCallback } from 'react';
import dayjs from 'dayjs';

type CsvRow = Record<string, unknown>;

interface ExportOptions {
  filename?: string;
  dateFormat?: string;
  customHeaders?: string[];
  customTransform?: (row: CsvRow) => CsvRow;
}

const FORMULA_PREFIX = /^[=+\-@\t\r]/;
const NEEDS_QUOTING = /[",\r\n]/;
const ISO_DATE_PREFIX = /^\d{4}-\d{2}-\d{2}/;

/** Serialises one value as an RFC 4180 CSV field; string cells that start like a formula are neutralised. */
export const toCsvCell = (value: unknown, dateFormat = 'YYYY-MM-DD'): string => {
  if (value === null || value === undefined) return '';
  if (dayjs.isDayjs(value)) return value.format(dateFormat);

  let text: string;
  if (typeof value === 'string') {
    text = ISO_DATE_PREFIX.test(value) ? dayjs(value).format(dateFormat) : value;
    // OWASP CSV-injection guard: spreadsheets evaluate cells starting with these characters.
    if (FORMULA_PREFIX.test(text)) text = `'${text}`;
  } else if (typeof value === 'object') {
    text = JSON.stringify(value);
  } else {
    text = String(value);
  }

  return NEEDS_QUOTING.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

export const toCsv = (rows: CsvRow[], columns: string[], dateFormat = 'YYYY-MM-DD'): string =>
  [
    columns.map(column => toCsvCell(column)),
    ...rows.map(row => columns.map(column => toCsvCell(row[column], dateFormat))),
  ]
    .map(cells => cells.join(','))
    .join('\r\n');

// Excel only decodes a CSV as UTF-8 when it starts with a byte-order mark.
export const CSV_BOM = '\uFEFF';

export const useExportToCSV = () => {
  const exportToCSV = useCallback((data: CsvRow[], options: ExportOptions = {}) => {
    if (!data?.length) return;

    const { filename = 'export', dateFormat = 'YYYY-MM-DD', customHeaders, customTransform } = options;

    const transformedData = customTransform ? data.map(customTransform) : data;

    const headers = customHeaders || Object.keys(transformedData[0]);

    const csvContent = toCsv(transformedData, headers, dateFormat);

    const blob = new Blob([CSV_BOM, csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', `${filename}_${dayjs().format('YYYY-MM-DD')}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, []);

  return exportToCSV;
};
