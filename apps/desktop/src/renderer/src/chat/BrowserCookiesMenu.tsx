import { useCallback, useMemo, useState } from 'react';
import Alert from '@mui/joy/Alert';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Checkbox from '@mui/joy/Checkbox';
import DialogContent from '@mui/joy/DialogContent';
import DialogTitle from '@mui/joy/DialogTitle';
import Divider from '@mui/joy/Divider';
import Dropdown from '@mui/joy/Dropdown';
import IconButton from '@mui/joy/IconButton';
import Input from '@mui/joy/Input';
import Link from '@mui/joy/Link';
import Menu from '@mui/joy/Menu';
import MenuButton from '@mui/joy/MenuButton';
import MenuItem from '@mui/joy/MenuItem';
import Modal from '@mui/joy/Modal';
import ModalDialog from '@mui/joy/ModalDialog';
import Option from '@mui/joy/Option';
import Select from '@mui/joy/Select';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import {
  MAX_IMPORT_SITES,
  type ChromeCookieHost,
  type ChromeProfile,
  type CookieImportResult,
  type CookieImportState,
} from '@shared/browserCookies';
import { MoreIcon, TrashIcon, WarningIcon } from './icons';

/** Enough of the chooser to scroll, without a dialog that outgrows a short window. */
const LIST_HEIGHT = 260;

type Step = 'closed' | 'choose' | 'importing' | 'done';

function skipLabel(reason: string): string {
  if (reason === 'expired') return 'already expired';
  if (reason === 'unsupported-format') return 'stored in a format this build cannot read';
  if (reason === 'undecryptable') return 'could not be decrypted';
  return 'refused by the browser';
}

/**
 * Bringing the user's own Chrome sessions into the agent's browser.
 *
 * The entry point is a kebab in the pane's url bar, and it is the ONLY way an import happens:
 * there is no tool behind any of this, so the model can neither start one nor name a site for
 * one. The sites offered come from the user's own Chrome profile and never from the open page,
 * which is what stops "ask the user to click import" from being a way to pick the target.
 *
 * Two steps on purpose. Choosing reads host names out of Chrome's database, which are stored in
 * the clear - no decryption and no Keychain prompt. Only the second step asks macOS to unlock
 * the key, by which time the user has already seen exactly which sites it will be used on.
 */
export function BrowserCookiesMenu({
  state,
  onState,
}: {
  state: CookieImportState;
  onState: (state: CookieImportState) => void;
}) {
  const [step, setStep] = useState<Step>('closed');
  const [managing, setManaging] = useState(false);
  const [profiles, setProfiles] = useState<ChromeProfile[]>([]);
  const [profileDir, setProfileDir] = useState('');
  const [hosts, setHosts] = useState<ChromeCookieHost[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [filter, setFilter] = useState('');
  // Folded away until asked for. The list is every site this profile has a cookie for, which is
  // the user's browsing history - enumerating it on screen to ask permission to read it would
  // be its own disclosure, and with everything ticked there is nothing to do in it by default.
  const [listOpen, setListOpen] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<CookieImportResult | null>(null);

  const loadHosts = useCallback(async (dir: string) => {
    setHosts([]);
    setPicked([]);
    const found = await window.b4m.browser.cookies.listHosts(dir);
    if (!found.ok) {
      setError(found.message);
      return;
    }
    setError('');
    setHosts(found.hosts);
    // Everything ticked, because taking the whole profile is what this is normally for. The
    // ticks are still what the import reads, so narrowing it is unticking rather than a
    // different code path.
    setPicked(found.hosts.map(host => host.host));
  }, []);

  const openChooser = useCallback(async () => {
    setStep('choose');
    setResult(null);
    setFilter('');
    setError('');
    setListOpen(false);
    const found = await window.b4m.browser.cookies.listProfiles();
    if (!found.ok) {
      setProfiles([]);
      setError(found.message);
      return;
    }
    setProfiles(found.profiles);
    const first = found.profiles.find(profile => profile.primary) ?? found.profiles[0];
    setProfileDir(first?.dir ?? '');
    if (first) await loadHosts(first.dir);
  }, [loadHosts]);

  const runImport = useCallback(async () => {
    setStep('importing');
    const outcome = await window.b4m.browser.cookies.import({ profileDir, hosts: picked });
    setResult(outcome);
    setStep('done');
    if (outcome.ok) onState(outcome.state);
  }, [profileDir, picked, onState]);

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return needle ? hosts.filter(host => host.host.includes(needle)) : hosts;
  }, [hosts, filter]);

  const toggle = (host: string) =>
    setPicked(current =>
      current.includes(host) ? current.filter(entry => entry !== host) : [...current, host].slice(0, MAX_IMPORT_SITES)
    );

  return (
    <>
      <Dropdown>
        <MenuButton
          slots={{ root: IconButton }}
          slotProps={{ root: { size: 'sm', variant: 'plain', color: 'neutral', 'data-testid': 'chat-browser-menu' } }}
          aria-label="Browser options"
        >
          <MoreIcon />
        </MenuButton>
        <Menu size="sm" placement="bottom-end" sx={{ maxWidth: 300 }}>
          <MenuItem
            disabled={!state.supported}
            onClick={() => void openChooser()}
            data-testid="chat-browser-import-cookies"
          >
            Import cookies from Chrome...
          </MenuItem>
          <MenuItem
            disabled={state.sites.length === 0}
            onClick={() => setManaging(true)}
            data-testid="chat-browser-manage-cookies"
          >
            Manage imported sites...
          </MenuItem>
          {!state.supported && (
            <Typography level="body-xs" textColor="text.tertiary" sx={{ px: 1.5, py: 0.75, maxWidth: 280 }}>
              {state.unsupported}
            </Typography>
          )}
        </Menu>
      </Dropdown>

      <Modal open={step !== 'closed'} onClose={() => setStep('closed')}>
        <ModalDialog sx={{ width: 460, maxWidth: '90vw' }} data-testid="chat-browser-cookies-dialog">
          <DialogTitle>Import cookies from Chrome</DialogTitle>
          <DialogContent sx={{ gap: 1.5 }}>
            {step === 'done' && result ? (
              <ImportOutcome result={result} />
            ) : (
              <Stack spacing={1.5}>
                {error && (
                  <Alert color="danger" variant="soft" size="sm" data-testid="chat-browser-cookies-error">
                    {error}
                  </Alert>
                )}
                {profiles.length > 1 && (
                  <Select
                    size="sm"
                    value={profileDir}
                    onChange={(_event, value) => {
                      if (typeof value !== 'string') return;
                      setProfileDir(value);
                      void loadHosts(value);
                    }}
                    slotProps={{ button: { 'data-testid': 'chat-browser-cookies-profile' } }}
                  >
                    {profiles.map(profile => (
                      <Option key={profile.dir} value={profile.dir}>
                        {profile.name}
                      </Option>
                    ))}
                  </Select>
                )}
                {profiles.length === 1 && (
                  <Typography level="body-xs" textColor="text.tertiary">
                    From your Chrome profile {profiles[0].name}.
                  </Typography>
                )}
                <Stack direction="row" alignItems="center" spacing={1}>
                  <Typography level="body-sm" sx={{ flex: 1, minWidth: 0 }}>
                    {picked.length === hosts.length
                      ? `Every site in this profile (${hosts.length})`
                      : `${picked.length} of ${hosts.length} sites`}
                  </Typography>
                  <Link
                    level="body-xs"
                    component="button"
                    onClick={() => setListOpen(open => !open)}
                    data-testid="chat-browser-cookies-toggle-list"
                  >
                    {listOpen ? 'Hide sites' : 'Choose sites'}
                  </Link>
                </Stack>
                {listOpen && (
                  <Stack direction="row" spacing={1} alignItems="center">
                    <Input
                      size="sm"
                      placeholder="Filter sites"
                      value={filter}
                      onChange={event => setFilter(event.target.value)}
                      sx={{ flex: 1, minWidth: 0 }}
                      slotProps={{ input: { 'data-testid': 'chat-browser-cookies-filter' } }}
                    />
                    <Link
                      level="body-xs"
                      component="button"
                      onClick={() => setPicked(picked.length === hosts.length ? [] : hosts.map(host => host.host))}
                      data-testid="chat-browser-cookies-select-all"
                    >
                      {picked.length === hosts.length ? 'None' : 'All'}
                    </Link>
                  </Stack>
                )}
                <Box
                  sx={{
                    display: listOpen ? 'block' : 'none',
                    height: LIST_HEIGHT,
                    overflowY: 'auto',
                    border: '1px solid',
                    borderColor: 'divider',
                    borderRadius: 'sm',
                    p: 1,
                  }}
                >
                  <Stack spacing={0.25}>
                    {shown.map(host => (
                      <Checkbox
                        key={host.host}
                        size="sm"
                        checked={picked.includes(host.host)}
                        onChange={() => toggle(host.host)}
                        label={
                          <Typography level="body-sm" noWrap>
                            {host.host}{' '}
                            <Typography level="body-xs" textColor="text.tertiary">
                              ({host.cookies})
                            </Typography>
                          </Typography>
                        }
                        slotProps={{ input: { 'data-testid': `chat-browser-cookies-site-${host.host}` } }}
                      />
                    ))}
                    {shown.length === 0 && !error && (
                      <Typography level="body-xs" textColor="text.tertiary">
                        No sites to show.
                      </Typography>
                    )}
                  </Stack>
                </Box>
                <Alert color="warning" variant="soft" size="sm" startDecorator={<WarningIcon />}>
                  <Stack spacing={0.5}>
                    <Typography level="body-xs">
                      {picked.length === 0
                        ? 'No sites are selected, so nothing would be imported. Choose sites to pick some back.'
                        : picked.length === hosts.length
                          ? `Every site this Chrome profile holds a cookie for - ${hosts.length} of them - will be imported. Choose sites to narrow it.`
                          : `${picked.length} of ${hosts.length} sites will be imported. Only those are read; the rest of your Chrome cookies are never decrypted.`}
                    </Typography>
                    <Typography level="body-xs">
                      macOS will ask for your login password to unlock the Chrome key. The agent will then be signed in
                      as you on those sites, in every conversation in this window, until you quit the app or clear the
                      browser.
                    </Typography>
                  </Stack>
                </Alert>
              </Stack>
            )}
          </DialogContent>
          <Stack direction="row" spacing={1} justifyContent="flex-end" sx={{ pt: 1 }}>
            <Button size="sm" variant="plain" color="neutral" onClick={() => setStep('closed')}>
              {step === 'done' ? 'Close' : 'Cancel'}
            </Button>
            {step !== 'done' && (
              <Button
                size="sm"
                color="warning"
                loading={step === 'importing'}
                disabled={picked.length === 0}
                onClick={() => void runImport()}
                data-testid="chat-browser-cookies-confirm"
              >
                Import {picked.length > 0 ? `${picked.length} site${picked.length === 1 ? '' : 's'}` : ''}
              </Button>
            )}
          </Stack>
        </ModalDialog>
      </Modal>

      <ManageSitesDialog open={managing} state={state} onClose={() => setManaging(false)} onState={onState} />
    </>
  );
}

function ImportOutcome({ result }: { result: CookieImportResult }) {
  if (!result.ok) {
    return (
      <Alert color="danger" variant="soft" size="sm" data-testid="chat-browser-cookies-failed">
        {result.message}
      </Alert>
    );
  }
  const total = result.imported.reduce((sum, site) => sum + site.cookies, 0);
  return (
    <Stack spacing={1} data-testid="chat-browser-cookies-imported">
      <Typography level="body-sm">
        Imported {total} cookie{total === 1 ? '' : 's'} for {result.imported.length} site
        {result.imported.length === 1 ? '' : 's'}.
      </Typography>
      <Stack spacing={0.25}>
        {result.imported.map(site => (
          <Typography key={site.host} level="body-xs" textColor="text.tertiary">
            {site.host} - {site.cookies}
          </Typography>
        ))}
      </Stack>
      {result.skipped.length > 0 && (
        <Stack spacing={0.25}>
          {result.skipped.map(skip => (
            <Typography key={skip.reason} level="body-xs" textColor="text.tertiary">
              {skip.cookies} left behind: {skipLabel(skip.reason)}.
            </Typography>
          ))}
        </Stack>
      )}
    </Stack>
  );
}

/** What has been imported, with a way to take one site back out, or to empty the jar. */
function ManageSitesDialog({
  open,
  state,
  onClose,
  onState,
}: {
  open: boolean;
  state: CookieImportState;
  onClose: () => void;
  onState: (state: CookieImportState) => void;
}) {
  const [busy, setBusy] = useState(false);

  const run = async (work: Promise<CookieImportState>) => {
    setBusy(true);
    try {
      onState(await work);
    } finally {
      setBusy(false);
    }
  };

  // Removing the last site closes this on its own: there is nothing left for it to manage, and
  // leaving an empty dialog up would read as a failure rather than as the thing having worked.
  return (
    <Modal open={open && state.sites.length > 0} onClose={onClose}>
      <ModalDialog sx={{ width: 420, maxWidth: '90vw' }} data-testid="chat-browser-sites-dialog">
        <DialogTitle>Imported sites</DialogTitle>
        <DialogContent sx={{ gap: 1.5 }}>
          <Stack spacing={1}>
            <Typography level="body-xs" textColor="text.tertiary">
              The agent is signed in as you on {state.sites.length} site{state.sites.length === 1 ? '' : 's'}, in every
              conversation in this window. They go when you quit the app.
            </Typography>
            {/* The names ARE shown here, unlike anywhere else: this is the screen the user opened
                to act on them one by one, so withholding them would leave nothing to act on. It
                scrolls because a whole profile is hundreds of rows. */}
            <Stack spacing={0.5} sx={{ maxHeight: 280, overflowY: 'auto' }}>
              {state.sites.map(site => (
                <Stack key={site.host} direction="row" alignItems="center" spacing={1}>
                  <Stack sx={{ flex: 1, minWidth: 0 }}>
                    <Typography level="body-sm" noWrap>
                      {site.host}
                    </Typography>
                    <Typography level="body-xs" textColor="text.tertiary">
                      {site.cookies} cookie{site.cookies === 1 ? '' : 's'} from {site.profile}
                    </Typography>
                  </Stack>
                  <IconButton
                    size="sm"
                    variant="plain"
                    color="danger"
                    disabled={busy}
                    aria-label={`Remove ${site.host}`}
                    onClick={() => void run(window.b4m.browser.cookies.forget(site.host))}
                    data-testid={`chat-browser-forget-${site.host}`}
                  >
                    <TrashIcon />
                  </IconButton>
                </Stack>
              ))}
            </Stack>
            <Divider />
            <Typography level="body-xs" textColor="text.tertiary">
              Clearing signs the browser out of everything, including any dev server the agent signed in to itself, and
              empties its cache and local storage.
            </Typography>
          </Stack>
        </DialogContent>
        <Stack direction="row" spacing={1} justifyContent="flex-end" sx={{ pt: 1 }}>
          <Button size="sm" variant="plain" color="neutral" onClick={onClose}>
            Close
          </Button>
          <Button
            size="sm"
            color="danger"
            loading={busy}
            onClick={() => void run(window.b4m.browser.cookies.clear())}
            data-testid="chat-browser-clear-cookies"
          >
            Clear browser data
          </Button>
        </Stack>
      </ModalDialog>
    </Modal>
  );
}
