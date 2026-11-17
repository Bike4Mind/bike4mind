import { useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Button, FormControl, FormLabel, Modal, ModalDialog, Stack, Textarea, Tooltip, Typography } from '@mui/joy';
import { toast } from 'sonner';
import type { IFabFileDocument, IResolvedPromptDispatch, StudioCompositionResponse } from '@bike4mind/common';
import EmbeddedFileBrowser, { type EmbeddedFileBrowserHandle } from '@client/app/components/Files/EmbeddedFileBrowser';
import { updateSessionsQueryData } from '@client/app/hooks/data/sessions';
import { useChatInput } from '@client/app/hooks/useChatInput';
import { useFeatureEnabled } from '@client/app/hooks/useFeatureEnabled';
import { generateNewSession } from '@client/app/utils/sessionsAPICalls';
import { DIRECTOR_TOOLS, buildDirectorSystemContext } from './directorTools';

const BRIEF_MAX_LENGTH = 1000;
const SESSION_NAME_BRIEF_LENGTH = 40;

const makeNonce = (): string =>
  globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;

type DirectDialogProps = {
  composition: Pick<StudioCompositionResponse, 'id' | 'brief'>;
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

  const submit = async () => {
    if (!trimmedBrief || creating) return;
    setCreating(true);
    try {
      const session = await generateNewSession(`Direct: ${trimmedBrief.slice(0, SESSION_NAME_BRIEF_LENGTH)}`);
      updateSessionsQueryData(queryClient, 'write', session);
      const promptContent = [
        `Direct this production: ${trimmedBrief}`,
        ...(product ? [`Product photo (Files id): ${product.id}`] : []),
      ].join('\n');
      const dispatch: IResolvedPromptDispatch = {
        promptId: 'production-direct',
        dispatchNonce: makeNonce(),
        promptContent,
        promptName: 'Direct production',
        isHidden: false,
        requiredTools: [...DIRECTOR_TOOLS],
        systemContext: buildDirectorSystemContext(composition.id),
        forceAgent: true,
        sessionId: session.id,
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
                placeholder="A 20 second launch ad for our new running shoe"
                slotProps={{ textarea: { 'data-testid': 'production-direct-brief-input' } }}
              />
            </FormControl>
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
