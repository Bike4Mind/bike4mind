import { useCallback } from 'react';
import dayjs from 'dayjs';
import { downloadData } from '@client/app/utils/download';
import { CSV_BOM, toCsvFromRecords } from '@client/app/utils/csv';

type CsvRow = Record<string, unknown>;

interface ExportOptions {
  filename?: string;
  dateFormat?: string;
  customHeaders?: string[];
  customTransform?: (row: CsvRow) => CsvRow;
}

export const useExportToCSV = () => {
  const exportToCSV = useCallback((data: CsvRow[], options: ExportOptions = {}) => {
    if (!data?.length) return;

    const { filename = 'export', dateFormat = 'YYYY-MM-DD', customHeaders, customTransform } = options;

    const transformedData = customTransform ? data.map(customTransform) : data;

    const headers = customHeaders || Object.keys(transformedData[0]);

    const csvContent = toCsvFromRecords(transformedData, headers, dateFormat);

    downloadData(CSV_BOM + csvContent, `${filename}_${dayjs().format('YYYY-MM-DD')}.csv`, 'text/csv;charset=utf-8;');
  }, []);

  return exportToCSV;
};
