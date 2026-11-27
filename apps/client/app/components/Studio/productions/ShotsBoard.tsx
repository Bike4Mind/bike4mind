import { useState } from 'react';
import { styled } from '@mui/system';
import { Button, Chip, IconButton, Input, Stack, Textarea, Typography } from '@mui/joy';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  STUDIO_COMPOSITION_LIMITS,
  studioFileMediaKind,
  type IFabFileDocument,
  type StudioCharacter,
  type StudioCompositionResponse,
  type StudioShot,
  type StudioTimeline,
} from '@bike4mind/common';
import { fabFileKeys } from '@client/app/hooks/data/fabFileKeys';
import { getFabFileByIdFromServer } from '@client/app/utils/filesAPICalls';
import { StudioPanel, StudioSectionLabel } from '../design/StudioPanel';
import { studioColor, studioRadius } from '../design/studioTokens';
import { toggleShotCharacter } from './characterEdits';
import FieldSaveStatus from './FieldSaveStatus';
import LibraryThumb from './LibraryThumb';
import {
  addShot,
  addTakes,
  chooseTake,
  moveShot,
  removeShot,
  removeTake,
  sendShotsToTimeline,
  shotTimelineFileId,
  updateShot,
  type StudioShotPatch,
} from './shotListEdits';
import { useFieldAutosave } from './useFieldAutosave';
import { useLibraryPicker } from './useLibraryPicker';

const ShotList = styled('ol')({ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '10px' });

const ShotCard = styled('li')({
  display: 'grid',
  gap: '10px',
  padding: '12px',
  borderRadius: studioRadius('lg'),
  border: `1px solid ${studioColor('hairline')}`,
  background: studioColor('raised'),
});

const ShotNumber = styled('span')({
  minWidth: '24px',
  fontWeight: 700,
  fontVariantNumeric: 'tabular-nums',
  color: studioColor('text-muted'),
});

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

type ShotsBoardProps = {
  composition: StudioCompositionResponse;
  timeline: StudioTimeline;
  onTimelineChange: (timeline: StudioTimeline) => void;
  /** Appends one file to the video track, sized from its media like a Library pick. */
  onSendTake: (file: IFabFileDocument) => void;
};

/**
 * The shots board: the production's ordered shot list, each shot's prompt and takes, and the chosen take that goes
 * to the timeline, one shot at a time or the whole board laid end to end.
 */
const ShotsBoard = ({ composition, timeline, onTimelineChange, onSendTake }: ShotsBoardProps) => {
  const { value: shots, set, status } = useFieldAutosave(composition.id, 'shots', composition.shots);
  const { pick, picker } = useLibraryPicker();
  const queryClient = useQueryClient();

  // Loads (or reads the cached) file docs for the takes about to be sent, so a thumbnail still loading is not
  // mistaken for a non-visual take.
  const loadFiles = async (fileIds: string[]) => {
    const failed = new Set<string>();
    const files = await Promise.all(
      fileIds.map(fileId =>
        queryClient
          .ensureQueryData({ queryKey: fabFileKeys.doc(fileId), queryFn: () => getFabFileByIdFromServer(fileId) })
          .catch(error => {
            console.error('Could not load a shot take', error);
            failed.add(fileId);
            return undefined;
          })
      )
    );
    return { files: new Map(files.flatMap(file => (file ? [[file.id, file] as const] : []))), failed };
  };
  const isVisualFile = (file: IFabFileDocument | undefined) => {
    const kind = file ? studioFileMediaKind(file.mimeType) : undefined;
    return kind === 'image' || kind === 'video';
  };

  const edit = (change: (current: StudioShot[]) => StudioShot[]) => {
    try {
      set(change(shots));
    } catch (error) {
      toast.error(errorText(error));
    }
  };

  const pickTakes = (shotId: string) =>
    pick({
      filter: { mode: 'initial', type: 'image' },
      onPicked: files =>
        edit(current =>
          addTakes(
            current,
            shotId,
            files.map(file => file.id)
          )
        ),
    });

  const sendAll = async () => {
    const { files } = await loadFiles(shots.flatMap(shot => shotTimelineFileId(shot) ?? []));
    try {
      onTimelineChange(sendShotsToTimeline(timeline, shots, fileId => isVisualFile(files.get(fileId))));
      toast.success('Shots sent to the timeline');
    } catch (error) {
      toast.error(errorText(error));
    }
  };

  const sendOne = async (shot: StudioShot) => {
    const fileId = shotTimelineFileId(shot);
    const loaded = fileId ? await loadFiles([fileId]) : undefined;
    const file = fileId ? loaded?.files.get(fileId) : undefined;
    if (fileId && loaded?.failed.has(fileId)) {
      toast.error('Could not load this take. Try again.');
      return;
    }
    if (!file || !isVisualFile(file)) {
      toast.error('Pick an image or video take for this shot first.');
      return;
    }
    onSendTake(file);
  };

  const sendableCount = shots.filter(shotTimelineFileId).length;

  return (
    <StudioPanel testId="production-shots-board" aria-label="Shots">
      <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap" useFlexGap>
        <StudioSectionLabel>Shots</StudioSectionLabel>
        <FieldSaveStatus status={status} testId="production-shots-save-status" />
        <Button
          size="sm"
          variant="outlined"
          onClick={() => edit(addShot)}
          disabled={shots.length >= STUDIO_COMPOSITION_LIMITS.shotsMax}
          data-testid="production-shots-add-btn"
        >
          Add shot
        </Button>
        <Button
          size="sm"
          onClick={() => void sendAll()}
          disabled={sendableCount === 0}
          data-testid="production-shots-send-all-btn"
        >
          Send all to timeline
        </Button>
      </Stack>

      {shots.length === 0 ? (
        <Typography level="body-sm" data-testid="production-shots-empty">
          No shots yet. Add one, then pick its takes from your Library.
        </Typography>
      ) : (
        <ShotList>
          {shots.map((shot, index) => (
            <ShotRow
              key={shot.id}
              shot={shot}
              index={index}
              isLast={index === shots.length - 1}
              onPatch={patch => edit(current => updateShot(current, shot.id, patch))}
              onMove={offset => edit(current => moveShot(current, shot.id, offset))}
              onRemove={() => edit(current => removeShot(current, shot.id))}
              onPickTakes={() => pickTakes(shot.id)}
              onChoose={fileId => edit(current => chooseTake(current, shot.id, fileId))}
              onRemoveTake={fileId => edit(current => removeTake(current, shot.id, fileId))}
              onSend={() => void sendOne(shot)}
              characters={composition.brandKit.characters}
              onToggleCharacter={characterId =>
                edit(current => toggleShotCharacter(current, shot.id, characterId, composition.brandKit.characters))
              }
            />
          ))}
        </ShotList>
      )}
      {picker}
    </StudioPanel>
  );
};

type ShotRowProps = {
  shot: StudioShot;
  index: number;
  isLast: boolean;
  onPatch: (patch: StudioShotPatch) => void;
  onMove: (offset: -1 | 1) => void;
  onRemove: () => void;
  onPickTakes: () => void;
  onChoose: (fileId: string) => void;
  onRemoveTake: (fileId: string) => void;
  onSend: () => void;
  characters: readonly StudioCharacter[];
  onToggleCharacter: (characterId: string) => void;
};

const ShotRow = ({
  shot,
  index,
  isLast,
  onPatch,
  onMove,
  onRemove,
  onPickTakes,
  onChoose,
  onRemoveTake,
  onSend,
  characters,
  onToggleCharacter,
}: ShotRowProps) => {
  const testId = `production-shot-${index}`;
  return (
    <ShotCard data-testid={testId} data-shot-id={shot.id}>
      <Stack direction="row" spacing={1} alignItems="center">
        <ShotNumber>{index + 1}</ShotNumber>
        <CommitInput
          value={shot.title}
          ariaLabel={`Shot ${index + 1} title`}
          maxLength={STUDIO_COMPOSITION_LIMITS.shotTitleMaxLength}
          testId={`${testId}-title-input`}
          onCommit={title => onPatch({ title })}
          sx={{ flex: 1, fontWeight: 600 }}
        />
        {shot.intent && (
          <Chip size="sm" variant="soft" data-testid={`${testId}-intent`}>
            {shot.intent}
          </Chip>
        )}
        <IconButton
          size="sm"
          variant="plain"
          aria-label="Move shot up"
          disabled={index === 0}
          onClick={() => onMove(-1)}
          data-testid={`${testId}-up-btn`}
        >
          <ArrowUpwardIcon fontSize="small" />
        </IconButton>
        <IconButton
          size="sm"
          variant="plain"
          aria-label="Move shot down"
          disabled={isLast}
          onClick={() => onMove(1)}
          data-testid={`${testId}-down-btn`}
        >
          <ArrowDownwardIcon fontSize="small" />
        </IconButton>
        <IconButton
          size="sm"
          variant="plain"
          color="danger"
          aria-label="Remove shot"
          onClick={onRemove}
          data-testid={`${testId}-remove-btn`}
        >
          <DeleteOutlineIcon fontSize="small" />
        </IconButton>
      </Stack>

      <CommitInput
        value={shot.voiceLine ?? ''}
        ariaLabel={`Shot ${index + 1} voice line`}
        placeholder="Voiceover or caption line"
        maxLength={STUDIO_COMPOSITION_LIMITS.shotVoiceLineMaxLength}
        testId={`${testId}-voice-line-input`}
        onCommit={voiceLine => onPatch({ voiceLine })}
      />
      <CommitTextarea
        value={shot.prompt ?? ''}
        ariaLabel={`Shot ${index + 1} prompt`}
        placeholder="Describe the shot: subject, setting, camera, mood"
        maxLength={STUDIO_COMPOSITION_LIMITS.shotPromptMaxLength}
        testId={`${testId}-prompt-input`}
        onCommit={prompt => onPatch({ prompt })}
      />

      {characters.length > 0 && (
        <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap>
          <Typography level="body-xs">Features:</Typography>
          {characters.map(character => {
            const featured = shot.characterIds?.includes(character.id) ?? false;
            return (
              <Chip
                key={character.id}
                size="sm"
                variant={featured ? 'solid' : 'outlined'}
                color={featured ? 'primary' : 'neutral'}
                aria-pressed={featured}
                onClick={() => onToggleCharacter(character.id)}
                data-testid={`${testId}-character-${character.id}-chip`}
              >
                {character.name}
              </Chip>
            );
          })}
        </Stack>
      )}

      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
        {shot.fileIds.map(fileId => {
          const isChosen = fileId === shot.chosenFileId;
          return (
            <LibraryThumb
              key={fileId}
              fileId={fileId}
              selected={isChosen}
              selectLabel={isChosen ? 'Chosen take' : 'Choose this take'}
              onSelect={() => onChoose(fileId)}
              onRemove={() => onRemoveTake(fileId)}
              testId={`${testId}-take-${fileId}`}
            />
          );
        })}
        {shot.clipFileId && (
          <LibraryThumb
            fileId={shot.clipFileId}
            testId={`${testId}-clip`}
            badge={
              <Chip size="sm" variant="solid" sx={{ position: 'absolute', bottom: 2, left: 2 }}>
                Clip
              </Chip>
            }
          />
        )}
        {shot.fileIds.length < STUDIO_COMPOSITION_LIMITS.shotFilesMax && (
          <Button size="sm" variant="outlined" onClick={onPickTakes} data-testid={`${testId}-add-takes-btn`}>
            {shot.fileIds.length === 0 ? 'Add takes from Library' : 'Add takes'}
          </Button>
        )}
        <Button
          size="sm"
          variant="plain"
          disabled={!shotTimelineFileId(shot)}
          onClick={onSend}
          data-testid={`${testId}-send-btn`}
          sx={{ marginLeft: 'auto' }}
        >
          Send to timeline
        </Button>
      </Stack>
    </ShotCard>
  );
};

type CommitFieldProps = {
  value: string;
  ariaLabel: string;
  maxLength: number;
  testId: string;
  onCommit: (value: string) => void;
  placeholder?: string;
};

// Text is edited locally and committed on blur, so a field being typed into is never trimmed or reset under the caret.
const useCommitText = ({ value, onCommit }: Pick<CommitFieldProps, 'value' | 'onCommit'>) => {
  const [draft, setDraft] = useState(value);
  const [committed, setCommitted] = useState(value);
  if (value !== committed) {
    setCommitted(value);
    setDraft(value);
  }
  return {
    value: draft,
    onChange: (event: { target: { value: string } }) => setDraft(event.target.value),
    onBlur: () => {
      if (draft === value) return;
      if (!draft.trim() && value) setDraft(value);
      onCommit(draft);
    },
  };
};

const CommitInput = ({
  sx,
  ariaLabel,
  maxLength,
  testId,
  placeholder,
  ...props
}: CommitFieldProps & { sx?: Record<string, unknown> }) => {
  const field = useCommitText(props);
  return (
    <Input
      size="sm"
      variant="plain"
      placeholder={placeholder}
      {...field}
      onKeyDown={event => event.key === 'Enter' && event.target instanceof HTMLElement && event.target.blur()}
      sx={sx}
      slotProps={{ input: { maxLength, 'aria-label': ariaLabel, 'data-testid': testId } }}
    />
  );
};

const CommitTextarea = ({ ariaLabel, maxLength, testId, placeholder, ...props }: CommitFieldProps) => {
  const field = useCommitText(props);
  return (
    <Textarea
      size="sm"
      minRows={2}
      maxRows={6}
      placeholder={placeholder}
      {...field}
      slotProps={{ textarea: { maxLength, 'aria-label': ariaLabel, 'data-testid': testId } }}
    />
  );
};

export default ShotsBoard;
