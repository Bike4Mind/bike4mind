import { useCallback } from 'react';
import { useNavigate } from '@tanstack/react-router';
import type { ReferenceFile } from '@client/app/components/Studio/capabilityFields';
import { useStudioRestore } from '@client/app/components/Studio/restore/studioRestore';

/**
 * Opens Studio's image form in edit mode with `source` (a Files image) as the image to edit. `model` preselects the
 * model the image was made with when that model can edit it; otherwise the form ranks one.
 */
export function useOpenStudioImageEdit(): (source: ReferenceFile, model?: string) => void {
  const navigate = useNavigate();
  const requestRestore = useStudioRestore(state => state.requestRestore);
  return useCallback(
    (source, model) => {
      requestRestore({
        medium: 'image',
        request: { mode: 'edit', ...(model && { model }) },
        lineageInputs: [{ fileId: source.fileId, role: 'edit_source' }],
        fileNames: { [source.fileId]: source.fileName },
        handoff: true,
      });
      void navigate({ to: '/studio/$modality', params: { modality: 'image' } });
    },
    [navigate, requestRestore]
  );
}
