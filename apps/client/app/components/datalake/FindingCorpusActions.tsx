import { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  DialogContent,
  DialogTitle,
  FormControl,
  FormLabel,
  Input,
  Modal,
  ModalClose,
  ModalDialog,
  Radio,
  RadioGroup,
  Textarea,
  Typography,
} from '@mui/joy';
import CloseIcon from '@mui/icons-material/Close';
import type { IDataLakeFindingDocument, LakeFindingSource } from '@bike4mind/common';
import { LAKE_CORPUS_ACTION_NOTE_MAX_CHARS, MAX_LAKE_FILE_TAG_NAME_LENGTH, MAX_TAXONOMY_TAGS } from '@bike4mind/common';
import { serverRefusalMessage, useApplyCorpusAction, useLakeFileTags } from '@client/app/hooks/data/dataLakes';

/**
 * The three corpus actions (#3046) a curator can take on an OPEN finding's cited documents: merge
 * (retire documents' MEMBERSHIP of this lake), supersede (retire one from RANKING, keep it in the
 * corpus), and retag (rewrite one's prefixed tags). Each is destructive, so each opens a
 * confirmation that names every affected file and states the consequence.
 *
 * Separate from the ruling controls ("Resolve"/"Dismiss", #3045) on purpose: a ruling records what
 * a curator decided and touches nothing, a corpus action moves a customer's documents. The server
 * keeps them on separate routes for the same reason, and this UI mirrors it. The finding is left
 * OPEN afterwards, which is what keeps a supersede undoable (`unsupersede` requires an open
 * finding).
 *
 * A closed finding offers nothing here: the server refuses every action on one, and the corpus
 * should not move under a decision nobody is currently making.
 */
export default function FindingCorpusActions({
  dataLakeId,
  finding,
}: {
  dataLakeId: string;
  finding: IDataLakeFindingDocument;
}) {
  const [mode, setMode] = useState<'merge' | 'supersede' | 'retag' | null>(null);

  if (finding.status !== 'open') return null;

  return (
    <Box data-testid="finding-corpus-actions" sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
      <Typography level="body-xs" textColor="text.tertiary">
        Change the corpus:
      </Typography>
      <Button
        size="sm"
        variant="outlined"
        color="neutral"
        onClick={() => setMode('merge')}
        data-testid="finding-corpus-merge-btn"
      >
        Merge
      </Button>
      <Button
        size="sm"
        variant="outlined"
        color="neutral"
        onClick={() => setMode('supersede')}
        data-testid="finding-corpus-supersede-btn"
      >
        Supersede
      </Button>
      <Button
        size="sm"
        variant="outlined"
        color="neutral"
        onClick={() => setMode('retag')}
        data-testid="finding-corpus-retag-btn"
      >
        Retag
      </Button>

      {mode === 'merge' && <MergeDialog dataLakeId={dataLakeId} finding={finding} onClose={() => setMode(null)} />}
      {mode === 'supersede' && (
        <SupersedeDialog dataLakeId={dataLakeId} finding={finding} onClose={() => setMode(null)} />
      )}
      {mode === 'retag' && <RetagDialog dataLakeId={dataLakeId} finding={finding} onClose={() => setMode(null)} />}
    </Box>
  );
}

/** The name a curator reads for one cited document. Falls back to the id when detection saw none. */
const sourceName = (source: LakeFindingSource): string => source.fileName ?? source.fabFileId;

function NoteField({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  return (
    <FormControl size="sm">
      <FormLabel>Note (optional)</FormLabel>
      <Textarea
        minRows={2}
        maxRows={4}
        value={value}
        onChange={event => onChange(event.target.value)}
        slotProps={{ textarea: { maxLength: LAKE_CORPUS_ACTION_NOTE_MAX_CHARS, 'data-testid': 'finding-corpus-note' } }}
      />
    </FormControl>
  );
}

function MergeDialog({
  dataLakeId,
  finding,
  onClose,
}: {
  dataLakeId: string;
  finding: IDataLakeFindingDocument;
  onClose: () => void;
}) {
  const apply = useApplyCorpusAction();
  const [keepId, setKeepId] = useState<string | null>(finding.sources[0]?.fabFileId ?? null);
  // Default: every other document retires. The curator can uncheck the ones to leave in place.
  const [retireIds, setRetireIds] = useState<string[]>(() => finding.sources.slice(1).map(source => source.fabFileId));
  const [note, setNote] = useState('');

  const chooseKeep = (id: string) => {
    setRetireIds(current => {
      const withoutNewKeep = current.filter(retireId => retireId !== id);
      // The document kept a moment ago now belongs in the retire set, so switching the winner
      // always leaves at least one candidate rather than emptying it (a two-source finding).
      return keepId && keepId !== id && !withoutNewKeep.includes(keepId) ? [...withoutNewKeep, keepId] : withoutNewKeep;
    });
    setKeepId(id);
  };
  const toggleRetire = (id: string) =>
    setRetireIds(current => (current.includes(id) ? current.filter(x => x !== id) : [...current, id]));

  const kept = finding.sources.find(source => source.fabFileId === keepId) ?? null;
  const retired = finding.sources.filter(source => source.fabFileId !== keepId && retireIds.includes(source.fabFileId));
  const canSubmit = !!kept && retired.length > 0 && !apply.isPending;

  const submit = () => {
    if (!kept) return;
    apply.mutate(
      {
        dataLakeId,
        findingId: finding.id,
        body: {
          action: 'merge',
          keepFabFileId: kept.fabFileId,
          retireFabFileIds: retired.map(source => source.fabFileId),
          note: note.trim() || undefined,
        },
      },
      { onSuccess: onClose }
    );
  };

  return (
    <CorpusDialog title="Merge documents" onClose={onClose} testId="finding-corpus-merge-dialog">
      <Typography level="body-sm">
        Keep one version. The others are removed from this lake - the documents themselves survive in their owners&apos;
        Files. You can undo this from the toast for the next 15 seconds; after that, only the file&apos;s owner can
        bring it back by re-adding it to the lake.
      </Typography>
      <FormControl>
        <FormLabel>Keep in this lake</FormLabel>
        <RadioGroup value={keepId} onChange={event => chooseKeep(event.target.value)}>
          {finding.sources.map(source => (
            <Box key={source.fabFileId} data-testid={`finding-corpus-merge-keep-${source.fabFileId}`}>
              <Radio value={source.fabFileId} label={sourceName(source)} />
            </Box>
          ))}
        </RadioGroup>
      </FormControl>
      <FormControl>
        <FormLabel>Remove from this lake</FormLabel>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
          {finding.sources
            .filter(source => source.fabFileId !== keepId)
            .map(source => (
              <Box key={source.fabFileId} data-testid={`finding-corpus-merge-retire-${source.fabFileId}`}>
                <Checkbox
                  checked={retireIds.includes(source.fabFileId)}
                  onChange={() => toggleRetire(source.fabFileId)}
                  label={sourceName(source)}
                />
              </Box>
            ))}
        </Box>
      </FormControl>
      <ConfirmList kept={kept} retired={retired} />
      <NoteField value={note} onChange={setNote} />
      <CorpusDialogActions
        pending={apply.isPending}
        disabled={!canSubmit}
        label="Merge"
        onSubmit={submit}
        onClose={onClose}
      />
    </CorpusDialog>
  );
}

function SupersedeDialog({
  dataLakeId,
  finding,
  onClose,
}: {
  dataLakeId: string;
  finding: IDataLakeFindingDocument;
  onClose: () => void;
}) {
  const apply = useApplyCorpusAction();
  const [keepId, setKeepId] = useState<string | null>(finding.sources[0]?.fabFileId ?? null);
  const [retireId, setRetireId] = useState<string | null>(finding.sources[1]?.fabFileId ?? null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Kept and Retired must name different files: choosing the file already on the other side moves
  // that side to the file just displaced (or, failing that, any other source).
  const otherSourceId = (excludeId: string, preferId: string | null) =>
    preferId && preferId !== excludeId
      ? preferId
      : (finding.sources.find(source => source.fabFileId !== excludeId)?.fabFileId ?? null);
  const chooseKeep = (id: string) => {
    if (id === retireId) setRetireId(otherSourceId(id, keepId));
    setKeepId(id);
    setError(null);
  };
  const chooseRetire = (id: string) => {
    if (id === keepId) setKeepId(otherSourceId(id, retireId));
    setRetireId(id);
    setError(null);
  };

  const kept = finding.sources.find(source => source.fabFileId === keepId) ?? null;
  const retired = finding.sources.find(source => source.fabFileId === retireId) ?? null;
  const canSubmit = !!kept && !!retired && kept.fabFileId !== retired.fabFileId && !apply.isPending;

  const submit = () => {
    if (!kept || !retired) return;
    setError(null);
    apply.mutate(
      {
        dataLakeId,
        findingId: finding.id,
        body: {
          action: 'supersede',
          keepFabFileId: kept.fabFileId,
          retireFabFileId: retired.fabFileId,
          note: note.trim() || undefined,
        },
      },
      {
        onSuccess: onClose,
        // The dialog stays open on a refusal, so the reason is shown here rather than only in a toast.
        onError: (err: Error) => setError(serverRefusalMessage(err) || err.message || 'Could not supersede'),
      }
    );
  };

  return (
    <CorpusDialog title="Supersede a document" onClose={onClose} testId="finding-corpus-supersede-dialog">
      <Typography level="body-sm">
        Keep both documents in this lake, but retire one from search ranking behind the current one. The retired
        document stays retrievable by name and id. You can undo this from the toast for the next 15 seconds.
      </Typography>
      <FormControl>
        <FormLabel>Current version (kept)</FormLabel>
        <RadioGroup value={keepId} onChange={event => chooseKeep(event.target.value)}>
          {finding.sources.map(source => (
            <Box key={source.fabFileId} data-testid={`finding-corpus-supersede-keep-${source.fabFileId}`}>
              <Radio value={source.fabFileId} label={sourceName(source)} />
            </Box>
          ))}
        </RadioGroup>
      </FormControl>
      <FormControl>
        <FormLabel>Older version (retired from ranking)</FormLabel>
        <RadioGroup value={retireId} onChange={event => chooseRetire(event.target.value)}>
          {finding.sources.map(source => (
            <Box key={source.fabFileId} data-testid={`finding-corpus-supersede-retire-${source.fabFileId}`}>
              <Radio value={source.fabFileId} label={sourceName(source)} />
            </Box>
          ))}
        </RadioGroup>
      </FormControl>
      <ConfirmList kept={kept} retired={retired ? [retired] : []} />
      <NoteField value={note} onChange={setNote} />
      {error && (
        <Alert color="danger" size="sm" data-testid="finding-corpus-supersede-error">
          <Typography level="body-xs">{error}</Typography>
        </Alert>
      )}
      <CorpusDialogActions
        pending={apply.isPending}
        disabled={!canSubmit}
        label="Supersede"
        onSubmit={submit}
        onClose={onClose}
      />
    </CorpusDialog>
  );
}

function RetagDialog({
  dataLakeId,
  finding,
  onClose,
}: {
  dataLakeId: string;
  finding: IDataLakeFindingDocument;
  onClose: () => void;
}) {
  const apply = useApplyCorpusAction();
  const [fileId, setFileId] = useState<string | null>(finding.sources[0]?.fabFileId ?? null);
  const { data: tags, isLoading, isError } = useLakeFileTags(dataLakeId, fileId);
  // `null` until the current set has actually arrived - never submit an empty seed, which under
  // replace semantics would strip every tag the file carries under the prefix.
  const [names, setNames] = useState<string[] | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');

  useEffect(() => {
    setNames(tags ? [...tags.current] : null);
    setDraft('');
    setError(null);
  }, [tags]);

  const selected = finding.sources.find(source => source.fabFileId === fileId) ?? null;
  const loading = isLoading || names === null;
  const canSubmit = !!selected && names !== null && !apply.isPending;

  const addTag = () => {
    const name = draft.trim();
    if (!tags || !name) return;
    if (!name.startsWith(tags.prefix)) return setError(`Tags must start with "${tags.prefix}"`);
    if (name === tags.prefix) return setError(`A tag needs a name after "${tags.prefix}"`);
    if (name.length > MAX_LAKE_FILE_TAG_NAME_LENGTH) return setError('That tag name is too long');
    // Mirrors `SetLakeFileTagsRequestInput` so the refusal is inline, not a late 400 on submit.
    if (/[\r\n]/.test(name)) return setError('A tag name cannot contain a line break');
    if ((names?.length ?? 0) >= MAX_TAXONOMY_TAGS) return setError('This document is at its tag limit');
    if (names?.includes(name)) return setError('That tag is already here');
    setError(null);
    setNames(current => [...(current ?? []), name]);
    setDraft('');
  };
  const removeTag = (name: string) => setNames(current => (current ?? []).filter(tag => tag !== name));

  const submit = () => {
    if (!selected || names === null) return;
    apply.mutate(
      {
        dataLakeId,
        findingId: finding.id,
        body: { action: 'retag', fabFileId: selected.fabFileId, tags: names, note: note.trim() || undefined },
      },
      { onSuccess: onClose }
    );
  };

  return (
    <CorpusDialog title="Retag a document" onClose={onClose} testId="finding-corpus-retag-dialog">
      <Typography level="body-sm">
        Set the tags this document carries under this lake&apos;s prefix to exactly the set below. There is no undo for
        a retag.
      </Typography>
      <FormControl>
        <FormLabel>Document</FormLabel>
        <RadioGroup value={fileId} onChange={event => setFileId(event.target.value)}>
          {finding.sources.map(source => (
            <Box key={source.fabFileId} data-testid={`finding-corpus-retag-file-${source.fabFileId}`}>
              <Radio value={source.fabFileId} label={sourceName(source)} />
            </Box>
          ))}
        </RadioGroup>
      </FormControl>

      {isError ? (
        <Alert color="danger" size="sm" data-testid="finding-corpus-retag-error">
          <Typography level="body-xs">Could not read this document&apos;s current tags. Try again.</Typography>
        </Alert>
      ) : (
        <FormControl>
          <FormLabel>{tags ? `Current tags (prefix "${tags.prefix}")` : 'Current tags'}</FormLabel>
          {loading ? (
            <Typography level="body-xs" textColor="text.tertiary" data-testid="finding-corpus-retag-loading">
              Loading current tags...
            </Typography>
          ) : (
            <>
              <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', mb: 1 }}>
                {names?.length ? (
                  names.map(name => (
                    <Button
                      key={name}
                      size="sm"
                      variant="soft"
                      color="neutral"
                      endDecorator={<CloseIcon sx={{ fontSize: 14 }} />}
                      aria-label={`Remove tag ${name}`}
                      onClick={() => removeTag(name)}
                      data-testid={`finding-corpus-retag-remove-${name}`}
                    >
                      {name}
                    </Button>
                  ))
                ) : (
                  <Typography level="body-xs" textColor="text.tertiary">
                    No tags under this prefix.
                  </Typography>
                )}
              </Box>
              <Box sx={{ display: 'flex', gap: 1 }}>
                <Input
                  size="sm"
                  value={draft}
                  onChange={event => setDraft(event.target.value)}
                  placeholder={tags ? `${tags.prefix}finance` : 'tag name'}
                  slotProps={{ input: { 'data-testid': 'finding-corpus-retag-add-input' } }}
                  sx={{ flex: 1 }}
                />
                <Button
                  size="sm"
                  variant="outlined"
                  color="neutral"
                  onClick={addTag}
                  data-testid="finding-corpus-retag-add-btn"
                >
                  Add
                </Button>
              </Box>
              {error && (
                <Typography level="body-xs" color="danger" data-testid="finding-corpus-retag-invalid">
                  {error}
                </Typography>
              )}
            </>
          )}
        </FormControl>
      )}

      {!loading && !isError && (
        <Box data-testid="finding-corpus-retag-diff">
          <Typography level="body-xs" textColor="text.secondary">
            {selected ? sourceName(selected) : 'Document'}
          </Typography>
          <Typography level="body-xs" textColor="text.tertiary">
            {`After this change: ${names?.length ? names.join(', ') : 'no tags under this prefix'}`}
          </Typography>
        </Box>
      )}
      <NoteField value={note} onChange={setNote} />
      <CorpusDialogActions
        pending={apply.isPending}
        disabled={!canSubmit}
        label="Retag"
        onSubmit={submit}
        onClose={onClose}
      />
    </CorpusDialog>
  );
}

/** The files a confirmation is about, named by role - the issue's "names the affected files". */
function ConfirmList({ kept, retired }: { kept: LakeFindingSource | null; retired: LakeFindingSource[] }) {
  if (!kept && retired.length === 0) return null;
  return (
    <Box component="ul" data-testid="finding-corpus-confirm-list" sx={{ m: 0, pl: 2.5 }}>
      {kept && (
        <li>
          <Typography level="body-xs">{`Kept: ${sourceName(kept)}`}</Typography>
        </li>
      )}
      {retired.map(source => (
        <li key={source.fabFileId}>
          <Typography level="body-xs">{`Retired: ${sourceName(source)}`}</Typography>
        </li>
      ))}
    </Box>
  );
}

function CorpusDialog({
  title,
  testId,
  onClose,
  children,
}: {
  title: string;
  testId: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <Modal open onClose={onClose}>
      <ModalDialog data-testid={testId} sx={{ maxWidth: 560 }}>
        <ModalClose />
        <DialogTitle>{title}</DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>{children}</DialogContent>
      </ModalDialog>
    </Modal>
  );
}

function CorpusDialogActions({
  pending,
  disabled,
  label,
  onSubmit,
  onClose,
}: {
  pending: boolean;
  disabled: boolean;
  label: string;
  onSubmit: () => void;
  onClose: () => void;
}) {
  return (
    <Box sx={{ display: 'flex', gap: 1, justifyContent: 'flex-end' }}>
      <Button size="sm" variant="plain" color="neutral" onClick={onClose} disabled={pending}>
        Cancel
      </Button>
      <Button
        size="sm"
        color="danger"
        loading={pending}
        disabled={disabled}
        onClick={onSubmit}
        data-testid="finding-corpus-confirm-btn"
      >
        {label}
      </Button>
    </Box>
  );
}
