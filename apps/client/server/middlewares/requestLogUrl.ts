/** Identifier searches must never put their query in application logs, even on rejected requests. */
export function requestLogUrl(url: string): string {
  const pathname = url.split('?')[0];
  return pathname === '/api/admin/search' ? pathname : url;
}
