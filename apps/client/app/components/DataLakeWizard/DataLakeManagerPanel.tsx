import { useCallback, useMemo, useState } from 'react';
import { Box } from '@mui/joy';
import { TREE_SCROLL_SX } from '@client/app/components/datalake/treeChrome';
import { useActiveDataLakeBatches, useGetDataLakes, useGetDataLakeTagCounts } from '@client/app/hooks/data/dataLakes';
import { useDataLakeWizardStore } from '@client/app/stores/useDataLakeWizardStore';
import { useAdminSettingsCache } from '@client/app/hooks/useAdminSettingsCache';
import DataLakeArticlePanel from './DataLakeArticlePanel';
import DataLakeDiscoverPanel from './DataLakeDiscoverPanel';
import { DataLakeSettingsModal } from './DataLakeSettingsModal';
import type { EditableLake } from './DataLakeSettingsModal';
import TaxonomyReviewPanel from './TaxonomyReviewPanel';
import type { IDataLakeBatchSummary, IFabFileDocument } from '@bike4mind/common';
import type { ManagerLake } from './manager/shared';
import { prefixSegments } from './manager/shared';
import ManagerNav from './manager/ManagerNav';
import { LakeInfoPanel, ManagerOverview } from './manager/LakeInfoPanel';

/**
 * Data Lakes management surface: one persistent two-pane layout. The left sidebar navigates
 * lakes -> categories -> files with the exact styling of the in-chat tree (treeChrome); the
 * right pane shows the selected lake's details/actions, or the file's content, or (at root)
 * the archived/deleted lifecycle sections. Replaces the old stacked list + viewer modals.
 */
export default function DataLakeManagerPanel() {
  const { data: dataLakes, isLoading } = useGetDataLakes();
  const { data: activeBatches } = useActiveDataLakeBatches();
  // Id only, not the batch object - `reviewingBatch` below is derived from the live, polled
  // `activeBatches` list so a re-analyze's cache refresh flows into the open review panel
  // instead of leaving it stuck showing pre-refresh suggestions.
  const [reviewingBatchId, setReviewingBatchId] = useState<string | null>(null);
  const reviewingBatch = useMemo(
    () => activeBatches?.find(b => b.id === reviewingBatchId) ?? null,
    [activeBatches, reviewingBatchId]
  );
  // One pass over the batch list, not a per-lake filter/find on every row render. Only batches
  // whose taxonomy phase actually needs attention are kept - a lake with none just misses the
  // map entry, which every consumer already treats the same as "nothing to show."
  const taxonomyBatchByLakeId = useMemo(() => {
    const map = new Map<string, IDataLakeBatchSummary>();
    for (const batch of activeBatches ?? []) {
      if (!batch.taxonomyStatus || batch.taxonomyStatus === 'none') continue;
      if (!map.has(batch.dataLakeId)) map.set(batch.dataLakeId, batch);
    }
    return map;
  }, [activeBatches]);
  const openWizard = useDataLakeWizardStore(s => s.openWizard);
  // Store-driven so openManager('discover') deep-links land on the public catalog; the
  // sidebar footer's Discover button flips it the same way.
  const managerTab = useDataLakeWizardStore(s => s.managerTab);
  const openManager = useDataLakeWizardStore(s => s.openManager);
  const { isFeatureEnabled } = useAdminSettingsCache();

  // The lakes list projection carries no per-lake file counts. Size a lake by MEMBERSHIP, not
  // by its `<prefix>:` tag matches: a lake whose files carry only the meta-tag (what the upload
  // wizard produces) reported 0 while its own file list showed them, and a multi-tagged file
  // was counted once per tag.
  const { data: tagCountsData } = useGetDataLakeTagCounts('datalakes');
  const lakeCount = useCallback(
    (lake: ManagerLake): number | undefined => tagCountsData?.lakeFileCounts?.[lake.datalakeTag],
    [tagCountsData]
  );

  const [lakeId, setLakeId] = useState<string | null>(null);
  const [path, setPath] = useState<string[]>([]);
  const [selectedFile, setSelectedFile] = useState<IFabFileDocument | null>(null);
  const [editingLakeId, setEditingLakeId] = useState<string | null>(null);

  // Derived, not effect-synced: when the active lake vanishes from the list (archived or
  // deleted), this goes null and the panel falls back to the root view on its own. The stale
  // path/file are unreachable behind the null and reset on the next lake click.
  const activeLake = useMemo(() => dataLakes?.find(l => l.id === lakeId) ?? null, [dataLakes, lakeId]);

  // Derive the lake being edited from the LIVE list (by id) rather than a snapshot, so a
  // visibility mutation's cache refresh flows into the settings modal instead of leaving the
  // Visibility control showing stale pre-mutation state.
  const editingLake = useMemo<EditableLake | null>(() => {
    const l = dataLakes?.find(d => d.id === editingLakeId);
    return l
      ? {
          id: l.id,
          name: l.name,
          description: l.description ?? '',
          requiredUserTag: l.requiredUserTag ?? '',
          requiredEntitlement: l.requiredEntitlement ?? '',
          organizationId: l.organizationId ?? '',
          isPublic: l.isPublic ?? false,
          // '' both when unset and when the server withheld it (non-editors never receive
          // the text); the modal renders the field off canManage, never off this value.
          systemPrompt: l.systemPrompt ?? '',
          canManage: !!l.canManage,
        }
      : null;
  }, [dataLakes, editingLakeId]);

  const selectLake = (lake: ManagerLake) => {
    setLakeId(lake.id);
    // Seed past the shared prefix root so the first in-lake view shows its categories
    // instead of a single redundant folder named like the lake.
    setPath(prefixSegments(lake.fileTagPrefix));
    setSelectedFile(null);
    // Opening one of YOUR lakes leaves the public catalog, so backing out of the lake
    // lands on the overview, not back in Discover.
    if (managerTab !== 'mine') openManager('mine');
  };

  // Discover swaps the right pane, but the activeLake branch below outranks it - so a click
  // while a lake was open changed nothing on screen, then surfaced later as the catalog
  // appearing when the user pressed Back. Exit the lake on the way in. Toggling back out is
  // the only exit that does not require owning a lake to click.
  const toggleDiscover = () => {
    if (managerTab === 'discover') {
      openManager('mine');
      return;
    }
    setLakeId(null);
    setPath([]);
    setSelectedFile(null);
    openManager('discover');
  };

  // Shared choke point for every manager entry point: with the feature off the lakes
  // queries 403 and the empty panel is a dead end, so never render - even if some (future)
  // ungated caller opens the manager. Mirrors the render guard in SendToDataLakeModal.
  // Placed after all hooks so the hook order is stable.
  if (!isFeatureEnabled('EnableDataLakes')) return null;

  return (
    // No header bar: the nav floats as a full-height card (same chrome as the in-chat tree)
    // and the modal's ModalClose sits in the top-right corner across from it.
    <Box
      data-testid="datalake-manager-panel"
      sx={{ display: 'flex', height: '100%', minHeight: 0, overflow: 'hidden', p: '12px', gap: '12px' }}
    >
      <ManagerNav
        lakes={dataLakes}
        lakesLoading={isLoading}
        lakeCount={lakeCount}
        taxonomyBatchByLakeId={taxonomyBatchByLakeId}
        activeLake={activeLake}
        path={path}
        selectedFileId={selectedFile?.id ?? null}
        onSelectLake={selectLake}
        onNavigate={p => {
          setPath(p);
          setSelectedFile(null);
        }}
        onExitLake={() => {
          setLakeId(null);
          setPath([]);
          setSelectedFile(null);
        }}
        onSelectFile={setSelectedFile}
        onCreateLake={openWizard}
        isDiscovering={managerTab === 'discover'}
        onDiscover={toggleDiscover}
        onReviewTaxonomy={setReviewingBatchId}
      />
      {activeLake ? (
        selectedFile ? (
          <DataLakeArticlePanel
            file={selectedFile}
            dataLakeId={activeLake.id}
            canManage={activeLake.canManage}
            onRemoved={() => setSelectedFile(null)}
          />
        ) : (
          <LakeInfoPanel
            lake={activeLake}
            fileCount={lakeCount(activeLake)}
            taxonomyBatch={taxonomyBatchByLakeId.get(activeLake.id)}
            onOpenSettings={() => setEditingLakeId(activeLake.id)}
            onReviewTaxonomy={setReviewingBatchId}
            onArchived={() => {
              setLakeId(null);
              setPath([]);
              setSelectedFile(null);
            }}
          />
        )
      ) : managerTab === 'discover' ? (
        // Public-lake catalog (store deep-link openManager('discover') or the footer button).
        <Box sx={{ ...TREE_SCROLL_SX, minWidth: 0, px: 1 }}>
          <DataLakeDiscoverPanel />
        </Box>
      ) : (
        <ManagerOverview />
      )}

      <DataLakeSettingsModal lake={editingLake} onClose={() => setEditingLakeId(null)} />

      {/* Review/apply the background AI tag suggestions for a batch */}
      {reviewingBatch && (
        <TaxonomyReviewPanel
          batch={reviewingBatch}
          prefix={dataLakes?.find(l => l.id === reviewingBatch.dataLakeId)?.fileTagPrefix ?? ''}
          onClose={() => setReviewingBatchId(null)}
        />
      )}
    </Box>
  );
}
