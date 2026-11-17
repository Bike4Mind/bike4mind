import { useState, type FormEvent } from 'react';
import { Button, Input, Modal, ModalClose, ModalDialog, Stack, Textarea, Typography } from '@mui/joy';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { STUDIO_COMPOSITION_LIMITS, type StudioCompositionResponse } from '@bike4mind/common';
import { studioCompositionKeys, useCreateStudioComposition } from '@client/app/hooks/data/studioCompositions';
import { StudioSectionLabel } from '../design/StudioPanel';
import { hookVariationBody } from './hookVariation';
import LibraryThumb from './LibraryThumb';

const variationTitle = (title: string) =>
  `${title} - new hook`.slice(0, STUDIO_COMPOSITION_LIMITS.titleMaxLength);

/**
 * "Hook variation": copies the production with a different opener (line, prompt or take) and opens the copy. It
 * copies the last saved version, which the editor's autosave keeps within a moment of the screen.
 */
const HookVariationButton = ({ composition }: { composition: StudioCompositionResponse }) => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="outlined" onClick={() => setOpen(true)} data-testid="production-hook-variation-btn">
        Hook variation
      </Button>
      {open && <HookVariationDialog composition={composition} onClose={() => setOpen(false)} />}
    </>
  );
};

const HookVariationDialog = ({
  composition,
  onClose,
}: {
  composition: StudioCompositionResponse;
  onClose: () => void;
}) => {
  const queryClient = useQueryClient();
  const source =
    queryClient.getQueryData<StudioCompositionResponse>(studioCompositionKeys.detail(composition.id)) ?? composition;
  const opening = source.shots[0];
  const [title, setTitle] = useState(variationTitle(source.title));
  const [openingLine, setOpeningLine] = useState(opening?.title ?? '');
  const [openingPrompt, setOpeningPrompt] = useState(opening?.prompt ?? '');
  const [openingTake, setOpeningTake] = useState(opening?.chosenFileId);
  const create = useCreateStudioComposition();
  const navigate = useNavigate();

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim()) return;
    const body = hookVariationBody(source, {
      title,
      openingLine,
      openingPrompt,
      openingTakeFileId: openingTake,
    });
    create.mutate(body, {
      onSuccess: copy => {
        onClose();
        void navigate({ to: '/studio/productions/$compositionId', params: { compositionId: copy.id } });
      },
    });
  };

  return (
    <Modal open onClose={onClose}>
      <ModalDialog data-testid="production-hook-variation-dialog" sx={{ width: 'min(560px, 100vw)' }}>
        <ModalClose />
        <Typography level="title-md">New hook variation</Typography>
        <Typography level="body-sm">
          Copies this production with a different opening shot, so you can test hooks side by side.
        </Typography>
        <form onSubmit={onSubmit}>
          <Stack spacing={1.5}>
            <Stack spacing={0.5}>
              <StudioSectionLabel htmlFor="production-hook-variation-title">Title</StudioSectionLabel>
              <Input
                size="sm"
                id="production-hook-variation-title"
                value={title}
                onChange={event => setTitle(event.target.value)}
                slotProps={{
                  input: {
                    maxLength: STUDIO_COMPOSITION_LIMITS.titleMaxLength,
                    'data-testid': 'production-hook-variation-title-input',
                  },
                }}
              />
            </Stack>
            {opening ? (
              <>
                <Stack spacing={0.5}>
                  <StudioSectionLabel htmlFor="production-hook-variation-line">Opening line</StudioSectionLabel>
                  <Input
                    size="sm"
                    id="production-hook-variation-line"
                    value={openingLine}
                    onChange={event => setOpeningLine(event.target.value)}
                    slotProps={{
                      input: {
                        maxLength: STUDIO_COMPOSITION_LIMITS.shotTitleMaxLength,
                        'data-testid': 'production-hook-variation-line-input',
                      },
                    }}
                  />
                </Stack>
                <Stack spacing={0.5}>
                  <StudioSectionLabel htmlFor="production-hook-variation-prompt">Opening shot prompt</StudioSectionLabel>
                  <Textarea
                    size="sm"
                    minRows={2}
                    id="production-hook-variation-prompt"
                    value={openingPrompt}
                    onChange={event => setOpeningPrompt(event.target.value)}
                    slotProps={{
                      textarea: {
                        maxLength: STUDIO_COMPOSITION_LIMITS.shotPromptMaxLength,
                        'data-testid': 'production-hook-variation-prompt-input',
                      },
                    }}
                  />
                </Stack>
                {opening.fileIds.length > 1 && (
                  <Stack spacing={0.5}>
                    <StudioSectionLabel>Opening take</StudioSectionLabel>
                    <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                      {opening.fileIds.map(fileId => (
                        <LibraryThumb
                          key={fileId}
                          fileId={fileId}
                          size={64}
                          selected={fileId === openingTake}
                          selectLabel="Open on this take"
                          onSelect={() => setOpeningTake(fileId)}
                          testId={`production-hook-variation-take-${fileId}`}
                        />
                      ))}
                    </Stack>
                  </Stack>
                )}
              </>
            ) : (
              <Typography level="body-xs">This production has no shots yet, so the copy is an exact duplicate.</Typography>
            )}
            <Stack direction="row" spacing={1} justifyContent="flex-end">
              <Button size="sm" variant="plain" onClick={onClose}>
                Cancel
              </Button>
              <Button
                size="sm"
                type="submit"
                loading={create.isPending}
                disabled={!title.trim()}
                data-testid="production-hook-variation-create-btn"
              >
                Create variation
              </Button>
            </Stack>
          </Stack>
        </form>
      </ModalDialog>
    </Modal>
  );
};

export default HookVariationButton;
