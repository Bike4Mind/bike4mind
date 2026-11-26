import { useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Button, FormControl, FormLabel, Modal, ModalDialog, Stack, Textarea, Tooltip, Typography } from '@mui/joy';
import { toast } from 'sonner';
import {
  DIRECTOR_TOOLS,
  buildDirectorSystemContext,
  studioDirectorBriefing,
  type IFabFileDocument,
  type IResolvedPromptDispatch,
  type StudioCompositionResponse,
  randomUuid,
} from '@bike4mind/common';
import EmbeddedFileBrowser, { type EmbeddedFileBrowserHandle } from '@client/app/components/Files/EmbeddedFileBrowser';
import { updateSessionsQueryData } from '@client/app/hooks/data/sessions';
import { useChatInput } from '@client/app/hooks/useChatInput';
import { useFeatureEnabled } from '@client/app/hooks/useFeatureEnabled';
import { generateNewSession } from '@client/app/utils/sessionsAPICalls';

const BRIEF_MAX_LENGTH = 1000;
const SESSION_NAME_BRIEF_LENGTH = 40;

const productLines = (picked: IFabFileDocument | null, brandProducts: readonly string[]): string[] => {
  if (picked) return [`Product photo (Files id): ${picked.id}`];
  const [onFile] = brandProducts;
  // The shots already take the brand kit's product as their reference; saying so keeps a re-direct from stalling
  // on a request for a photo the production already has.
  return onFile ? [`Product photo: already in the brand kit (${onFile}); every shot uses it.`] : [];
};

// Without the names the director cannot pass a shot's characters to production_storyboard.
const characterLines = (characters: readonly { name: string }[]): string[] =>
  characters.length > 0
    ? [
        `Saved characters: ${characters.map(character => character.name).join(', ')}. Name the ones who appear in ` +
          "a shot in that shot's characters.",
      ]
    : [];

type LaunchCopy = { piece: string; placeholder: string; productPhoto: boolean };

const AD_COPY: LaunchCopy = {
  piece: 'ad',
  placeholder: 'A 20 second launch ad for our new running shoe',
  productPhoto: true,
};
const FILM_COPY: LaunchCopy = {
  piece: 'film',
  placeholder: 'A lighthouse keeper finds a message in a bottle addressed to her',
  productPhoto: false,
};

const sameBrief = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

type DirectedShot = NonNullable<StudioCompositionResponse['shots']>[number];

// A template's starter shots have only a title and intent; a shot is part of an earlier ad once it has a prompt, a
// voice line or takes.
const isAuthoredShot = (shot: DirectedShot): boolean =>
  Boolean(shot.prompt?.trim() || shot.voiceLine?.trim() || (shot.fileIds?.length ?? 0) > 0);

// A Direct launch on a production that already has shots is the user asking for a new ad; without saying so the
// storyboard tool refuses the new lines and the director reads the brief as a follow-up that keeps every shot. The
// replace is scoped to this message: the director carries it into later turns otherwise (a swap rebuilt the ad).
const redirectLines = (
  shots: readonly DirectedShot[],
  brief: string,
  savedBrief: string | undefined,
  piece: string
): string[] => {
  const shotCount = shots.filter(isAuthoredShot).length;
  return shotCount > 0 && !sameBrief(brief, savedBrief ?? '')
    ? [
        `It already has ${shotCount} shot${shotCount === 1 ? '' : 's'} from an earlier brief. This brief replaces ` +
          `that ${piece}: write a new storyboard for it with production_storyboard, passing rewriteLines: true and ` +
          'replace: true and no keep. That applies to this message only; on every later message keep each shot ' +
          'the user does not ask to change.',
      ]
    : [];
};

type DirectDialogProps = {
  composition: Pick<StudioCompositionResponse, 'id' | 'brief' | 'brandKit' | 'shots'> &
    Partial<Pick<StudioCompositionResponse, 'template' | 'timeline'>>;
  open: boolean;
  onClose: () => void;
};

export const DirectDialog = ({ composition, open, onClose }: DirectDialogProps) => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const setProgrammaticLaunch = useChatInput(state => state.setProgrammaticLaunch);
  const pickerRef = useRef<EmbeddedFileBrowserHandle>(null);
  const [brief, setBrief] = useState(composition.brief?.summary ?? '');
  const [product, setProduct] = useState<IFabFileDocument | null>(null);
  const [creating, setCreating] = useState(false);

  const trimmedBrief = brief.trim();
  const copy = composition.template === 'short_film' ? FILM_COPY : AD_COPY;
  const { template, timeline } = composition;
  const briefing =
    template && timeline ? studioDirectorBriefing({ template, brief: composition.brief, timeline }) : undefined;

  const submit = async () => {
    if (!trimmedBrief || creating) return;
    setCreating(true);
    try {
      const session = await generateNewSession(`Direct: ${trimmedBrief.slice(0, SESSION_NAME_BRIEF_LENGTH)}`);
      updateSessionsQueryData(queryClient, 'write', session);
      const promptContent = [
        `Direct this production: ${trimmedBrief}`,
        // The executor re-injects the director context on every turn of the marked session; the visible id is a
        // second anchor the model can quote back.
        `Production id: ${composition.id}`,
        'On every turn, change it only through the production tools, and report only what their results show.',
        ...(copy.productPhoto ? productLines(product, composition.brandKit?.productFileIds ?? []) : []),
        ...characterLines(composition.brandKit?.characters ?? []),
        ...redirectLines(composition.shots ?? [], trimmedBrief, composition.brief?.summary, copy.piece),
      ].join('\n');
      const dispatch: IResolvedPromptDispatch = {
        promptId: 'production-direct',
        dispatchNonce: randomUuid(),
        promptContent,
        promptName: 'Direct production',
        isHidden: false,
        requiredTools: [...DIRECTOR_TOOLS],
        systemContext: buildDirectorSystemContext(composition.id, briefing),
        forceAgent: true,
        sessionId: session.id,
        // Marks the notebook as directed, so a follow-up turn stays in agent mode with the production tools.
        productionCompositionId: composition.id,
      };
      setProgrammaticLaunch(dispatch);
      // Leaving the editor is intentional: it autosaves its local timeline draft, which would overwrite the
      // agent's writes if it stayed open.
      await navigate({ to: '/notebooks/$id', params: { id: session.id } });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not start directing. Please try again.');
      setCreating(false);
    }
  };

  return (
    <>
      <Modal open={open} onClose={creating ? undefined : onClose}>
        <ModalDialog data-testid="production-direct-dialog" sx={{ width: 480, maxWidth: '100%' }}>
          <Typography level="title-md">Direct this production</Typography>
          <Stack spacing={2}>
            <FormControl required>
              <FormLabel>Brief</FormLabel>
              <Textarea
                minRows={3}
                value={brief}
                onChange={event => setBrief(event.target.value.slice(0, BRIEF_MAX_LENGTH))}
                placeholder={copy.placeholder}
                slotProps={{ textarea: { 'data-testid': 'production-direct-brief-input' } }}
              />
            </FormControl>
            {copy.productPhoto && (
              <FormControl>
                <FormLabel>Product photo (optional)</FormLabel>
                <Stack direction="row" spacing={1} alignItems="center">
                  <Button
                    variant="outlined"
                    color="neutral"
                    size="sm"
                    onClick={() => pickerRef.current?.handleOpen()}
                    data-testid="production-direct-product-pick-btn"
                  >
                    {product ? 'Change photo' : 'Choose photo'}
                  </Button>
                  {product && (
                    <>
                      <Typography level="body-sm" data-testid="production-direct-product-name">
                        {product.fileName}
                      </Typography>
                      <Button
                        variant="plain"
                        color="neutral"
                        size="sm"
                        onClick={() => setProduct(null)}
                        data-testid="production-direct-product-clear-btn"
                      >
                        Clear
                      </Button>
                    </>
                  )}
                </Stack>
              </FormControl>
            )}
            <Stack direction="row" spacing={1} justifyContent="flex-end">
              <Button
                variant="plain"
                color="neutral"
                onClick={onClose}
                disabled={creating}
                data-testid="production-direct-cancel-btn"
              >
                Cancel
              </Button>
              <Button
                onClick={() => void submit()}
                disabled={!trimmedBrief}
                loading={creating}
                data-testid="production-direct-submit-btn"
              >
                Direct
              </Button>
            </Stack>
          </Stack>
        </ModalDialog>
      </Modal>
      <EmbeddedFileBrowser
        ref={pickerRef}
        lockedFilters={{ type: 'image' }}
        addButtonLabelKey="file_browser.add_files_to_production"
        onAdd={picked => setProduct(picked[0] ?? null)}
      />
    </>
  );
};

type DirectButtonProps = Pick<DirectDialogProps, 'composition'> & {
  /** The editor holds edits it cannot save on the way out, so leaving it would ask first. */
  blocked: boolean;
};

/**
 * Directing runs in agent mode; without it the launch would fall back to a plain chat with none of the tools, so
 * the button is not offered. While the editor's draft cannot be saved, leaving is blocked, so it is disabled.
 */
const DirectButton = ({ composition, blocked }: DirectButtonProps) => {
  const { isFeatureEnabled } = useFeatureEnabled();
  const [open, setOpen] = useState(false);
  if (!isFeatureEnabled('agentMode')) return null;
  return (
    <>
      <Tooltip title={blocked ? 'Fix the issues in the editor before directing' : ''}>
        <span>
          <Button
            variant="soft"
            size="sm"
            disabled={blocked}
            onClick={() => setOpen(true)}
            data-testid="production-direct-btn"
          >
            Direct
          </Button>
        </span>
      </Tooltip>
      {open && <DirectDialog composition={composition} open onClose={() => setOpen(false)} />}
    </>
  );
};

export default DirectButton;
