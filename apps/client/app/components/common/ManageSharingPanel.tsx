import React, { useEffect, useState } from 'react';
import { Box, CircularProgress, Divider } from '@mui/joy';
import { ShareActions } from './ShareActions';
import { AccessGateEditor } from './AccessGateEditor';
import { EmbedAllowlistEditor } from './EmbedAllowlistEditor';
import { getPublishedManageState, type PublishAccessGateRead } from '@client/app/utils/publishApi';

export interface ManageSharingPanelProps {
  publicId: string;
  title: string;
  /** Absolute canonical share URL (origin + /p path). */
  shareUrl: string;
  /** Current visibility from the row - reactive, so the panel reflects row changes. */
  visibility: string;
}

/**
 * Per-artifact sharing manager: social share row + access gate + embed allowlist,
 * all editable without re-publishing. Mounted (lazily) inside a Live Artifacts row.
 * Seeds the gate + embed list from the live record on mount; the gate and
 * visibility together decide whether the embed editor is offered (open-public only).
 */
export function ManageSharingPanel({ publicId, title, shareUrl, visibility }: ManageSharingPanelProps) {
  const [loading, setLoading] = useState(true);
  const [gate, setGate] = useState<PublishAccessGateRead>(null);
  const [initialOrigins, setInitialOrigins] = useState<string[]>([]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void getPublishedManageState(publicId)
      .then(state => {
        if (!active) return;
        setGate(state.accessGate);
        setInitialOrigins(state.embedOrigins);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [publicId]);

  const isOpenPublic = visibility === 'public' && gate === null;

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }} data-testid="manage-sharing-loading">
        <CircularProgress size="sm" />
      </Box>
    );
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }} data-testid="manage-sharing-panel">
      <ShareActions title={title} url={shareUrl} />
      <Divider />
      <AccessGateEditor publicId={publicId} visibility={visibility} initialGate={gate} onGateChange={setGate} />
      {isOpenPublic && <Divider />}
      <EmbedAllowlistEditor
        publicId={publicId}
        shareUrl={shareUrl}
        title={title}
        isOpenPublic={isOpenPublic}
        initialOrigins={initialOrigins}
        testIdPrefix="manage-embed"
      />
    </Box>
  );
}

export default ManageSharingPanel;
