export const FILE_TYPE_OPTIONS = [
  { value: 'all', label: 'All Files Type' },
  { value: 'text', label: 'Text' },
  { value: 'pdf', label: 'PDF' },
  { value: 'url', label: 'URL' },
  { value: 'image', label: 'Image' },
  { value: 'excel', label: 'Excel' },
  { value: 'word', label: 'Word (DOCX)' },
  { value: 'json', label: 'JSON' },
  { value: 'csv', label: 'CSV' },
  { value: 'markdown', label: 'Markdown' },
  { value: 'code', label: 'Code' },
] as const;

export type FileTypeValue = Exclude<(typeof FILE_TYPE_OPTIONS)[number]['value'], 'all'>;
