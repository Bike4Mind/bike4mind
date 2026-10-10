import { createContext, useContext, useMemo, type MouseEvent } from 'react';
import Link from '@mui/joy/Link';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import type { ChatToolCall } from '@shared/chat';
import { WEB_FETCH_TOOL_NAME, WEB_SEARCH_TOOL_NAME, isWebUrl, parseWebSearchResults } from '@shared/webSearch';
import { SYSTEM_BROWSER_HINT, routePrLink, type BuiltInBrowserOpener } from './prLinks';

/**
 * Where a web tool row's links open: the conversation's built-in browser, routed the way the PR
 * bar's are (see prLinks.ts). A context rather than a prop so the memoized turns between
 * ChatShell and the row do not grow one; absent, links go to the system browser.
 */
export const WebLinkContext = createContext<BuiltInBrowserOpener | undefined>(undefined);

export function useWebSearchHits(call: ChatToolCall) {
  const preview = call.name === WEB_SEARCH_TOOL_NAME && call.status === 'done' ? (call.preview ?? '') : '';
  return useMemo(() => (preview ? parseWebSearchResults(preview) : []), [preview]);
}

function WebLink({ url, children, testId }: { url: string; children: string; testId: string }) {
  const opener = useContext(WebLinkContext);
  const open = (event: MouseEvent) => {
    event.preventDefault();
    routePrLink(url, event, opener);
  };
  return (
    <Link
      href={url}
      onClick={open}
      title={`${url}\n${SYSTEM_BROWSER_HINT}`}
      level="body-sm"
      underline="hover"
      sx={{ minWidth: 0, overflowWrap: 'anywhere' }}
      data-testid={testId}
    >
      {children}
    </Link>
  );
}

/** "3 results" beside a search row's label, where it cannot be ellipsized away. */
export function WebResultCount({ call }: { call: ChatToolCall }) {
  const hits = useWebSearchHits(call);
  // A label is how the tool says no search happened ("not configured"); a count would contradict it.
  if (call.name !== WEB_SEARCH_TOOL_NAME || call.status !== 'done' || !call.preview || call.label) return null;
  return (
    <Typography level="body-sm" textColor="text.tertiary" sx={{ flex: '0 0 auto' }} data-testid="chat-tool-row-count">
      {hits.length === 1 ? '1 result' : `${hits.length} results`}
    </Typography>
  );
}

/**
 * What a web tool call shows when opened, in place of its raw result. Null when there is nothing
 * better to show than that text - a failure, a "not configured" answer, a result that did not
 * parse - so the caller falls back to it.
 */
export function WebToolDetail({ call }: { call: ChatToolCall }) {
  const hits = useWebSearchHits(call);
  if (call.name === WEB_SEARCH_TOOL_NAME && hits.length > 0) {
    return (
      <Stack spacing={0.5} sx={{ mt: 0.5 }} data-testid="chat-tool-web-results">
        {hits.map((hit, index) => (
          <Stack key={`${index}-${hit.url}`} direction="row" spacing={0.75} alignItems="baseline" sx={{ minWidth: 0 }}>
            <WebLink url={hit.url} testId="chat-tool-web-result-link">
              {hit.title}
            </WebLink>
            <Typography level="body-xs" textColor="text.tertiary" noWrap sx={{ flex: '0 0 auto' }}>
              {hit.host}
            </Typography>
          </Stack>
        ))}
      </Stack>
    );
  }
  const url = typeof call.input.url === 'string' ? call.input.url : '';
  if (call.name === WEB_FETCH_TOOL_NAME && isWebUrl(url)) {
    return (
      <Stack sx={{ mt: 0.5 }} data-testid="chat-tool-web-source">
        <WebLink url={url} testId="chat-tool-web-source-link">
          {url}
        </WebLink>
      </Stack>
    );
  }
  return null;
}
