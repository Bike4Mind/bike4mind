import { useCallback } from 'react';
import dayjs from 'dayjs';

interface ExportOptions {
  filename?: string;
  dateFormat?: string;
  customHeaders?: string[];
  customTransform?: (data: any) => any;
}

export const useExportToCSV = () => {
  const exportToCSV = useCallback((data: any[], options: ExportOptions = {}) => {
    if (!data?.length) return;

    const { filename = 'export', dateFormat = 'YYYY-MM-DD', customHeaders, customTransform } = options;

    const transformedData = customTransform ? data.map(customTransform) : data;

    const headers = customHeaders || Object.keys(transformedData[0]);

    const csvContent = [
      headers.join(','),
      ...transformedData.map(item =>
        headers
          .map(header => {
            const value = item[header];
            if (value === null || value === undefined) return '';
            if (dayjs.isDayjs(value) || (typeof value === 'string' && value.match(/^\d{4}-\d{2}-\d{2}/))) {
              return dayjs(value).format(dateFormat);
            }
            if (typeof value === 'object') {
              return `"${JSON.stringify(value).replace(/"/g, '""')}"`;
            }
            if (typeof value === 'string' && value.includes(',')) {
              return `"${value.replace(/"/g, '""')}"`;
            }
            return value;
          })
          .join(',')
      ),
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', `${filename}_${dayjs().format('YYYY-MM-DD')}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }, []);

  return exportToCSV;
};
