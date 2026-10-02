import { useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  IconButton,
  Input,
  Link,
  Modal,
  ModalClose,
  ModalDialog,
  Radio,
  RadioGroup,
  Sheet,
  Stack,
  Typography,
} from '@mui/joy';
import GitHubIcon from '@mui/icons-material/GitHub';
import RefreshIcon from '@mui/icons-material/Refresh';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import { toast } from 'sonner';
import type { GitHubLakeInstallationChoice } from '@bike4mind/common';
import { useDataLakeWizardStore } from '@client/app/stores/useDataLakeWizardStore';
import { useCompleteLakeGitHubConnect, useLakeGitHubRepositoryChoices } from '@client/app/hooks/data/githubLake';
import { useBeginLakeGitHubConnect } from '@client/app/hooks/data/useBeginLakeGitHubConnect';
import { getServerErrorField } from '@client/app/utils/error';
import { saveGitHubLakeConnectHandoff } from '@client/app/utils/githubLakeConnectHandoff';

/** One repository, with the installation it came from - the complete call needs both ids. */
type SelectedRepo = { installationId: number; repositoryId: number };

const describeBoundRepo = (boundTo: { dataLakeName: string | null }): string =>
  boundTo.dataLakeName ? `Connected to ${boundTo.dataLakeName}` : 'Connected to another data lake';

/** Every (installation, repository) pair nothing has already claimed - what the picker can select. */
function listEligible(installations: GitHubLakeInstallationChoice[]): SelectedRepo[] {
  return installations
    .filter(installation => !installation.violation)
    .flatMap(installation =>
      installation.repositories
        .filter(repo => !repo.boundTo)
        .map(repo => ({
          installationId: installation.id,
          repositoryId: repo.id,
        }))
    );
}

/**
 * Picks the repository for a lake's GitHub connect, reading the list left by the authorize exchange
 * (useLakeGitHubRepositoryChoices). Mounted ONCE, in DataLakeManagerPanel, driven entirely by the
 * store's gitHubRepoPickerLakeId - GitHubConnectAction itself can render in more than one place on
 * screen at once (SelectedLakeHeader and the wizard's source step), so it must never own this modal.
 */
export default function GitHubRepositoryPickerModal() {
  const lakeId = useDataLakeWizardStore(s => s.gitHubRepoPickerLakeId);
  const closePicker = useDataLakeWizardStore(s => s.closeGitHubRepoPicker);
  const open = !!lakeId;

  const [prevLakeId, setPrevLakeId] = useState(lakeId);
  const [search, setSearch] = useState('');
  const [manualSelection, setManualSelection] = useState<SelectedRepo | null>(null);
  const [requestRepoNames, setRequestRepoNames] = useState<Record<number, string>>({});

  // A fresh lake (or a close) starts the picker's own UI state clean - the server's list is already
  // handled by react-query's own cache per lake id. Resetting here, during render, avoids an
  // extra post-render effect pass (see https://react.dev/learn/you-might-not-need-an-effect).
  if (lakeId !== prevLakeId) {
    setPrevLakeId(lakeId);
    setSearch('');
    setManualSelection(null);
    setRequestRepoNames({});
  }

  const { data, isLoading, isFetching, error, refetch } = useLakeGitHubRepositoryChoices(lakeId ?? undefined, open);
  const complete = useCompleteLakeGitHubConnect();
  const { begin: reconnect, isPending: reconnecting } = useBeginLakeGitHubConnect(lakeId ?? '');

  const installations = useMemo(() => data?.installations ?? [], [data]);
  const eligible = useMemo(() => listEligible(installations), [installations]);
  const organizationInstallations = useMemo(
    () => installations.filter(installation => installation.accountType === 'Organization'),
    [installations]
  );

  const filteredInstallations = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return installations;
    return installations
      .map(installation => ({
        ...installation,
        repositories: installation.repositories.filter(repo => repo.fullName.toLowerCase().includes(term)),
      }))
      .filter(installation => installation.violation || installation.repositories.length > 0);
  }, [installations, search]);

  // Re-derived against every fetch and the search filter, so a Refresh that shows the picked
  // repository as now bound - or a search that hides it - drops the pick instead of submitting a
  // repository that is not on screen. A single eligible repository is preselected.
  const visibleEligible = useMemo(() => listEligible(filteredInstallations), [filteredInstallations]);
  const stillEligible =
    manualSelection &&
    visibleEligible.find(
      repo =>
        repo.installationId === manualSelection.installationId && repo.repositoryId === manualSelection.repositoryId
    );
  const selected = stillEligible ?? (eligible.length === 1 && visibleEligible.length === 1 ? eligible[0] : null);

  const handleClose = () => closePicker();

  const handleConfirm = () => {
    if (!lakeId || !selected) return;
    complete.mutate(
      { dataLakeId: lakeId, installationId: selected.installationId, repositoryId: selected.repositoryId },
      {
        onSuccess: connection => {
          toast.success(`Connected ${connection.repositoryFullName}. Its first sync is queued.`);
          closePicker();
        },
        // The flow stays alive on a failure (a repo bound out from under the user, a policy
        // violation): keep the modal open so they can pick again instead of restarting from scratch.
        onError: (e: unknown) => toast.error(getServerErrorField(e) || 'Could not connect the repository.'),
      }
    );
  };

  const handleInstall = () => {
    if (!lakeId || !data?.installUrl) return;
    try {
      saveGitHubLakeConnectHandoff({ dataLakeId: lakeId });
    } catch {
      toast.error('Could not start the GitHub connection: this browser blocked session storage.');
      return;
    }
    window.location.assign(data.installUrl);
  };

  const handleCopyRequest = (installation: GitHubLakeInstallationChoice) => {
    const repoName = requestRepoNames[installation.id]?.trim() || 'the repository';
    const text =
      `Please add ${repoName} to the data-lake GitHub App installation on ${installation.accountLogin} ` +
      `so I can connect it to a data lake: ${installation.settingsUrl}`;
    const onCopyFailed = () => toast.error('Could not copy the request. Copy it manually instead.');
    // navigator.clipboard is undefined outside a secure context, where writeText would throw synchronously.
    if (!navigator.clipboard) {
      onCopyFailed();
      return;
    }
    navigator.clipboard
      .writeText(text)
      .then(() => toast.success('Copied the request to your clipboard.'), onCopyFailed);
  };

  return (
    <Modal open={open} onClose={handleClose}>
      <ModalDialog
        data-testid="github-repo-picker-modal"
        sx={{ width: 560, maxWidth: '90vw', maxHeight: '85vh', overflow: 'auto' }}
      >
        <ModalClose data-testid="github-repo-picker-close-btn" />
        <Typography level="title-lg" startDecorator={<GitHubIcon />}>
          Connect a GitHub repository
        </Typography>
        <Divider />

        {isLoading ? (
          <Stack alignItems="center" sx={{ py: 3 }}>
            <CircularProgress data-testid="github-repo-picker-loading" />
          </Stack>
        ) : error ? (
          <Alert color="danger" data-testid="github-repo-picker-error">
            <Stack gap={1}>
              <Typography level="body-sm">
                {getServerErrorField(error) ?? 'Could not load your GitHub repositories.'}
              </Typography>
              <Button
                data-testid="github-repo-picker-reconnect-btn"
                startDecorator={<GitHubIcon />}
                loading={reconnecting}
                onClick={reconnect}
                sx={{ alignSelf: 'flex-start' }}
              >
                Reconnect GitHub
              </Button>
            </Stack>
          </Alert>
        ) : (
          <>
            <Stack direction="row" gap={1}>
              <Input
                data-testid="github-repo-picker-search-input"
                placeholder="Search repositories"
                slotProps={{ input: { 'aria-label': 'Search repositories' } }}
                value={search}
                onChange={e => setSearch(e.target.value)}
                sx={{ flex: 1 }}
              />
              <Button
                data-testid="github-repo-picker-refresh-btn"
                variant="outlined"
                color="neutral"
                startDecorator={<RefreshIcon />}
                loading={isFetching}
                onClick={() => refetch()}
              >
                Refresh list
              </Button>
            </Stack>

            <Stack gap={2} sx={{ mt: 1 }}>
              {filteredInstallations.length === 0 && (
                <Typography level="body-sm" color="neutral" data-testid="github-repo-picker-empty">
                  {installations.length === 0
                    ? "The GitHub App isn't installed on any account you can see yet."
                    : 'No installation has a matching repository.'}
                </Typography>
              )}
              {filteredInstallations.map(installation => (
                <Box key={installation.id} data-testid={`github-repo-picker-installation-${installation.id}`}>
                  <Stack direction="row" gap={1} alignItems="center" sx={{ mb: 0.5 }}>
                    <Typography level="title-sm" id={`github-repo-picker-account-${installation.id}`}>
                      {installation.accountLogin}
                    </Typography>
                    <Chip size="sm" variant="soft" color="neutral">
                      {installation.accountType === 'Organization' ? 'Organization' : 'Personal'}
                    </Chip>
                  </Stack>

                  {installation.violation ? (
                    <Sheet
                      variant="soft"
                      color="warning"
                      sx={{ p: 1.5, borderRadius: 'sm' }}
                      data-testid={`github-repo-picker-violation-${installation.id}`}
                    >
                      <Typography level="body-sm">{installation.violation.message}</Typography>
                      <Link
                        href={installation.settingsUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        endDecorator={<OpenInNewIcon fontSize="small" />}
                        data-testid={`github-repo-picker-settings-link-${installation.id}`}
                      >
                        Open installation settings
                      </Link>
                    </Sheet>
                  ) : (
                    <RadioGroup
                      name={`github-repo-picker-installation-${installation.id}`}
                      aria-labelledby={`github-repo-picker-account-${installation.id}`}
                      value={selected?.installationId === installation.id ? String(selected.repositoryId) : ''}
                      onChange={e =>
                        setManualSelection({ installationId: installation.id, repositoryId: Number(e.target.value) })
                      }
                    >
                      <Stack gap={1}>
                        {installation.repositories.map(repo => (
                          <Box key={repo.id} data-testid={`github-repo-picker-row-${repo.id}`}>
                            <Radio
                              value={String(repo.id)}
                              disabled={!!repo.boundTo}
                              label={
                                <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap">
                                  <Typography level="body-sm">{repo.fullName}</Typography>
                                  <Typography level="body-xs" color="neutral">
                                    @ {repo.defaultBranch}
                                  </Typography>
                                  {repo.private && (
                                    <Chip size="sm" variant="soft" color="neutral">
                                      Private
                                    </Chip>
                                  )}
                                  {repo.boundTo && (
                                    <Chip
                                      size="sm"
                                      variant="soft"
                                      color="neutral"
                                      data-testid={`github-repo-picker-bound-chip-${repo.id}`}
                                    >
                                      {describeBoundRepo(repo.boundTo)}
                                    </Chip>
                                  )}
                                </Stack>
                              }
                            />
                          </Box>
                        ))}
                      </Stack>
                    </RadioGroup>
                  )}
                </Box>
              ))}
            </Stack>

            <Divider sx={{ my: 1 }} />
            <Typography level="title-sm">Don&apos;t see your repository?</Typography>
            <Stack gap={1}>
              <Button
                data-testid="github-repo-picker-install-btn"
                variant="outlined"
                color="neutral"
                startDecorator={<GitHubIcon />}
                disabled={!data?.installUrl}
                onClick={handleInstall}
                sx={{ alignSelf: 'flex-start' }}
              >
                Install on my account
              </Button>
              {organizationInstallations.length > 0 ? (
                organizationInstallations.map(installation => (
                  <Stack
                    key={installation.id}
                    gap={0.5}
                    data-testid={`github-repo-picker-org-request-${installation.id}`}
                  >
                    <Link
                      data-testid={`github-repo-picker-settings-link-${installation.id}`}
                      href={installation.settingsUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      endDecorator={<OpenInNewIcon fontSize="small" />}
                      level="body-sm"
                    >
                      Open installation settings ({installation.accountLogin})
                    </Link>
                    <Stack direction="row" gap={1}>
                      <Input
                        data-testid={`github-repo-picker-request-repo-input-${installation.id}`}
                        placeholder="owner/repo"
                        slotProps={{ input: { 'aria-label': `Repository to request on ${installation.accountLogin}` } }}
                        value={requestRepoNames[installation.id] ?? ''}
                        onChange={e => {
                          const { value } = e.target;
                          setRequestRepoNames(names => ({ ...names, [installation.id]: value }));
                        }}
                        sx={{ flex: 1 }}
                      />
                      <IconButton
                        data-testid={`github-repo-picker-copy-request-btn-${installation.id}`}
                        variant="outlined"
                        color="neutral"
                        aria-label={`Copy the request for ${installation.accountLogin}`}
                        onClick={() => handleCopyRequest(installation)}
                      >
                        <ContentCopyIcon />
                      </IconButton>
                    </Stack>
                  </Stack>
                ))
              ) : (
                <Typography level="body-xs" color="neutral">
                  An organization repository needs an owner to install the App on that organization. Use &quot;Install
                  on my account&quot; to pick the org and request it.
                </Typography>
              )}
            </Stack>

            <Divider sx={{ my: 1 }} />
            <Stack direction="row" justifyContent="flex-end" gap={1}>
              <Button data-testid="github-repo-picker-cancel-btn" variant="plain" color="neutral" onClick={handleClose}>
                Cancel
              </Button>
              <Button
                data-testid="github-repo-picker-confirm-btn"
                disabled={!selected}
                loading={complete.isPending}
                onClick={handleConfirm}
              >
                Connect repository
              </Button>
            </Stack>
          </>
        )}
      </ModalDialog>
    </Modal>
  );
}
