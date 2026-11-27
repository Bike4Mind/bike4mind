import { useEffect, useRef } from 'react';
import useSessionLayout, { setSessionLayout, type ArtifactData } from '@client/app/hooks/useSessionLayout';
import type { ReactArtifactGroupRole } from '@client/app/utils/reactArtifactGroup';

/**
 * Propagates an artifact preview card's LIVE content changes to the shared Knowledge Base
 * store, without letting a card overwrite the store merely by mounting.
 *
 * An iterated artifact's v1 and v2 chat cards share the same id (see ArtifactIdResolver) and
 * carry no version, so any same-id card that mounts would otherwise overwrite the store with
 * its own (possibly older) content - scrolling an old card into view downgraded the Knowledge
 * Base to a stale version (#457). This seeds a ref on the first observation (mount / scroll-in)
 * WITHOUT pushing, so only a content change seen while the card stays mounted (live streaming)
 * propagates; a scroll-driven (re)mount can no longer clobber the newest version.
 *
 * @param artifactId    the card's resolved artifact id
 * @param artifactType  the ArtifactData type this card represents (e.g. 'html' | 'react' | 'code')
 * @param contentKey    the string that changes on a live content edit, used for change
 *                      detection (e.g. the html/react content string, or the code body)
 * @param contentObject the full content object written into the store when contentKey changes
 */
export function useSelectedArtifactContentSync(
  artifactId: string,
  artifactType: ArtifactData['type'],
  contentKey: string,
  contentObject: ArtifactData['content'],
  reactGroup?: ReactArtifactGroupRole
): void {
  const lastObservedRef = useRef<{ contentKey: string; groupKey?: string } | null>(null);
  const groupKey = JSON.stringify(reactGroup);

  useEffect(() => {
    const currentState = useSessionLayout.getState();

    // Only sync while this artifact is the selected one.
    if (currentState.selectedArtifactId === artifactId && currentState.artifactData?.type === artifactType) {
      // First observation (mount / scroll-in): record, do not push - a remounted older card
      // must not overwrite fresher content already in the store.
      const previous = lastObservedRef.current;
      lastObservedRef.current = { contentKey, groupKey };
      if (previous === null) {
        return;
      }
      const contentChanged = previous.contentKey !== contentKey;
      const groupChanged = previous.groupKey !== groupKey;
      if (!contentChanged && !groupChanged) return;

      const updatedArtifact = {
        ...currentState.artifactData,
        ...(contentChanged ? { content: contentObject } : {}),
        ...(groupChanged ? { reactGroup } : {}),
      };

      // Compare the actual content to avoid unnecessary updates.
      if (JSON.stringify(currentState.artifactData) !== JSON.stringify(updatedArtifact)) {
        setSessionLayout({
          artifactData: updatedArtifact,
        });
      }
    }
    // Change detection intentionally keys on `contentKey` only (the streaming content), not on
    // the whole `contentObject`: this is a content-propagation guard, and keying on the full
    // object would both re-add per-render JSON.stringify churn and re-trigger on volatile fields
    // (the handlers stamp a fresh createdAt/updatedAt each render). A React group's sources and
    // dependency list have their own content key: sibling updates must refresh the open app even
    // when its entry source stays the same, without overwriting edits saved in the viewer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artifactId, artifactType, contentKey, groupKey]);
}
