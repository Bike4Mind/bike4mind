import { useEffect, useRef } from 'react';
import useSessionLayout, { setSessionLayout, type ArtifactData } from '@client/app/hooks/useSessionLayout';

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
  contentObject: ArtifactData['content']
): void {
  const lastObservedContentRef = useRef<string | null>(null);

  useEffect(() => {
    const currentState = useSessionLayout.getState();

    // Only sync while this artifact is the selected one.
    if (currentState.selectedArtifactId === artifactId && currentState.artifactData?.type === artifactType) {
      // First observation (mount / scroll-in): record, do not push - a remounted older card
      // must not overwrite fresher content already in the store.
      if (lastObservedContentRef.current === null) {
        lastObservedContentRef.current = contentKey;
        return;
      }
      if (lastObservedContentRef.current === contentKey) return;
      lastObservedContentRef.current = contentKey;

      // Compare the actual content to avoid unnecessary updates.
      if (JSON.stringify(currentState.artifactData.content) !== JSON.stringify(contentObject)) {
        setSessionLayout({
          artifactData: {
            ...currentState.artifactData,
            content: contentObject,
          },
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artifactId, artifactType, contentKey]);
}
