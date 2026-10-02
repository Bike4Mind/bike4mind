import { useEffect, useRef, useState } from 'react';
import Box from '@mui/joy/Box';
import IconButton from '@mui/joy/IconButton';
import Input from '@mui/joy/Input';
import LinearProgress from '@mui/joy/LinearProgress';
import Link from '@mui/joy/Link';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import type { CookieImportState } from '@shared/browserCookies';
import { resolveAddress } from '@shared/browserUrl';
import type { BrowserGoAction, BrowserPaneState } from '@shared/ipc';
import { BrowserCookiesMenu } from './BrowserCookiesMenu';
import { ArrowLeftIcon, ArrowRightIcon, ReloadIcon, WarningIcon } from './icons';

/**
 * The url bar above the agent's browser.
 *
 * Everything here is drawn by the RENDERER, above the rectangle the page is given - see
 * BrowserPane. The page is a native overlay, so anything drawn inside those bounds would be
 * behind it; that is why this is a sibling of the hole rather than a bar floating over it.
 *
 * It also holds the one thing the pane cannot show: why nothing arrived. A failed load usually
 * leaves the PREVIOUS page on screen, so an error only in the hole would be invisible exactly
 * when it is needed.
 *
 * And the standing cookie indicator. It is a row rather than a toast because what it reports is
 * a STATE, not an event: for as long as the agent's browser is carrying the user's own logins,
 * that has to be readable at a glance, including by someone who was not watching when it
 * started. It sits above the page for the same reason everything else here does.
 */
export function BrowserNavbar({
  state,
  cookies,
  onNavigate,
  onGo,
  onCookieState,
}: {
  state: BrowserPaneState;
  cookies: CookieImportState;
  onNavigate: (url: string) => void;
  onGo: (action: BrowserGoAction) => void;
  onCookieState: (state: CookieImportState) => void;
}) {
  const [draft, setDraft] = useState(state.url);
  const [typedError, setTypedError] = useState('');
  const editing = useRef(false);

  // A page the AGENT moved has to show up here, and a url the user is halfway through typing
  // must survive it: the field follows the page only while nobody is editing it.
  useEffect(() => {
    if (!editing.current) setDraft(state.url);
  }, [state.url]);

  const submit = () => {
    const resolved = resolveAddress(draft);
    if (!resolved.ok) {
      setTypedError(resolved.error);
      return;
    }
    setTypedError('');
    editing.current = false;
    setDraft(resolved.url);
    onNavigate(resolved.url);
  };

  const error = typedError || state.error;

  return (
    <Stack
      sx={{
        flexShrink: 0,
        px: 0.75,
        pt: 0.75,
        borderBottom: '1px solid',
        borderColor: 'divider',
        bgcolor: 'background.surface',
      }}
    >
      <Stack direction="row" spacing={0.25} alignItems="center">
        <IconButton
          size="sm"
          variant="plain"
          color="neutral"
          disabled={!state.canGoBack}
          onClick={() => onGo('back')}
          aria-label="Back"
          data-testid="chat-browser-back"
        >
          <ArrowLeftIcon />
        </IconButton>
        <IconButton
          size="sm"
          variant="plain"
          color="neutral"
          disabled={!state.canGoForward}
          onClick={() => onGo('forward')}
          aria-label="Forward"
          data-testid="chat-browser-forward"
        >
          <ArrowRightIcon />
        </IconButton>
        <IconButton
          size="sm"
          variant="plain"
          color="neutral"
          disabled={!state.url}
          onClick={() => onGo('reload')}
          aria-label="Reload"
          data-testid="chat-browser-reload"
        >
          <ReloadIcon />
        </IconButton>
        <Input
          size="sm"
          value={draft}
          placeholder="Search or enter address"
          spellCheck={false}
          autoComplete="off"
          error={!!error}
          onChange={event => {
            editing.current = true;
            setTypedError('');
            setDraft(event.target.value);
          }}
          onFocus={event => event.target.select()}
          onBlur={() => {
            editing.current = false;
            setDraft(state.url);
            setTypedError('');
          }}
          onKeyDown={event => {
            if (event.key === 'Enter') submit();
            // Escape puts back where the page actually is, which is the only way out of a
            // half-typed address that does not navigate somewhere by accident.
            if (event.key === 'Escape') {
              editing.current = false;
              setTypedError('');
              setDraft(state.url);
              event.currentTarget.blur();
            }
          }}
          sx={{ flex: 1, minWidth: 0, fontSize: 'xs' }}
          // On the field itself rather than on Joy's wrapper, so what finds it has its value.
          slotProps={{ input: { 'aria-label': 'Address', 'data-testid': 'chat-browser-url' } }}
        />
        <BrowserCookiesMenu state={cookies} onState={onCookieState} />
      </Stack>
      {cookies.sites.length > 0 && (
        <Stack
          direction="row"
          spacing={0.75}
          alignItems="center"
          sx={{
            mt: 0.75,
            px: 0.75,
            py: 0.5,
            borderRadius: 'sm',
            bgcolor: 'warning.softBg',
            color: 'warning.plainColor',
          }}
          data-testid="chat-browser-cookies-indicator"
        >
          <WarningIcon />
          <Typography level="body-xs" textColor="inherit" sx={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
            Signed in as you on {cookies.sites.map(site => site.host).join(', ')}
          </Typography>
          <Link
            level="body-xs"
            component="button"
            color="warning"
            onClick={() => void window.b4m.browser.cookies.clear().then(onCookieState)}
            data-testid="chat-browser-cookies-indicator-clear"
          >
            Clear
          </Link>
        </Stack>
      )}
      {error && (
        <Typography
          level="body-xs"
          color="danger"
          sx={{ px: 0.5, pt: 0.5, overflowWrap: 'anywhere' }}
          data-testid="chat-browser-error"
        >
          {error}
        </Typography>
      )}
      {/* Always present, so a load starting does not shove the page down two pixels. */}
      <Box sx={{ height: '2px', mt: 0.75 }}>
        {state.loading && (
          <LinearProgress
            data-testid="chat-browser-loading"
            sx={{ '--LinearProgress-thickness': '2px', '--LinearProgress-radius': '0px' }}
          />
        )}
      </Box>
    </Stack>
  );
}
