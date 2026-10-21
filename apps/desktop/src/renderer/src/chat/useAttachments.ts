import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { AddAttachmentsResult, ChatAttachment, ChatAttachmentInput, ChatImageRef } from '@shared/chat';

export interface AttachmentDraft {
  /** Attached to the next turn, in the order they were added. */
  attachments: ChatAttachment[];
  /** Set while files are being read and stored; the composer disables Send meanwhile. */
  busy: boolean;
  /** Why the last batch lost something. Cleared by the next batch or by dismissing it. */
  rejected: { name: string; reason: string }[];
  dismissRejected: () => void;
  /** The paste and drop paths, which hand over bytes or paths they already have. */
  add: (inputs: ChatAttachmentInput[]) => Promise<void>;
  /** The picker path; opens an OS dialog in main. */
  pick: () => Promise<void>;
  /** An image already in the thread, read back by main from its own store. */
  attachImage: (image: ChatImageRef) => Promise<void>;
  remove: (attachmentId: string) => void;
  /** Called once the turn is sent - the attachments now belong to the message, not the draft. */
  clear: () => void;
}

/**
 * Attachments waiting to be sent with the next turn.
 *
 * The BYTES are already on disk by the time anything lands here: `add` and `pick` both return
 * descriptors for files main has stored. That is what makes a removal cheap and a reload
 * survivable, and it is why `remove` also tells main to throw the file away rather than only
 * dropping it from this array.
 */
export function useAttachmentDraft(sessionId: string | null): AttachmentDraft {
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [rejected, setRejected] = useState<{ name: string; reason: string }[]>([]);

  const scope = useMemo(() => ({ sessionId, requests: new Set<symbol>() }), [sessionId]);
  const activeScope = useRef<typeof scope | null>(null);

  // A draft belongs to the conversation it was composed in; switching away abandons it rather
  // than carrying a screenshot into an unrelated thread.
  useLayoutEffect(() => {
    activeScope.current = scope;
    setAttachments([]);
    setRejected([]);
    setBusy(false);
    return () => {
      activeScope.current = null;
    };
  }, [scope]);

  const intake = useCallback(
    async (request: () => Promise<AddAttachmentsResult>) => {
      // A captured paste/drop callback may run after its session has been left.
      if (activeScope.current !== scope) return;
      const requestId = Symbol();
      scope.requests.add(requestId);
      const isCurrent = () => activeScope.current === scope && scope.requests.has(requestId);
      setBusy(true);
      setRejected([]);
      try {
        const result = await request();
        if (!isCurrent()) return;
        if (result.attachments.length > 0) setAttachments(current => [...current, ...result.attachments]);
        if (result.rejected.length > 0) setRejected(result.rejected);
      } finally {
        if (isCurrent()) {
          scope.requests.delete(requestId);
          setBusy(scope.requests.size > 0);
        }
      }
    },
    [scope]
  );

  const add = useCallback(
    async (inputs: ChatAttachmentInput[]) => {
      if (!sessionId || inputs.length === 0) return;
      await intake(() => window.b4m.chat.addAttachments(sessionId, inputs));
    },
    [sessionId, intake]
  );

  const pick = useCallback(async () => {
    if (!sessionId) return;
    await intake(() => window.b4m.chat.pickAttachments(sessionId));
  }, [sessionId, intake]);

  const attachImage = useCallback(
    async (image: ChatImageRef) => {
      if (!sessionId) return;
      await intake(() => window.b4m.chat.attachImage(sessionId, image));
    },
    [sessionId, intake]
  );

  const remove = useCallback(
    (attachmentId: string) => {
      setAttachments(current => current.filter(attachment => attachment.id !== attachmentId));
      if (sessionId) void window.b4m.chat.discardAttachment(sessionId, attachmentId);
    },
    [sessionId]
  );

  const clear = useCallback(() => {
    if (activeScope.current !== scope) return;
    scope.requests.clear();
    setAttachments([]);
    setRejected([]);
    setBusy(false);
  }, [scope]);

  const dismissRejected = useCallback(() => setRejected([]), []);

  return { attachments, busy, rejected, dismissRejected, add, pick, attachImage, remove, clear };
}

/**
 * Turn whatever a drop or a paste produced into something main can take in.
 *
 * A dropped file has a real path, which is the cheap route: main reads it directly and a 50MB
 * log never crosses IPC. A pasted screenshot exists only in the clipboard and has no path, so
 * its bytes do. `pathFor` returning '' is the signal to take the second route.
 */
export async function toAttachmentInputs(files: readonly File[]): Promise<ChatAttachmentInput[]> {
  const inputs = await Promise.all(
    files.map(async (file): Promise<ChatAttachmentInput> => {
      const path = window.b4m.files.pathFor(file);
      if (path) return { source: 'path', path };
      return {
        source: 'bytes',
        name: file.name || 'pasted-image.png',
        mediaType: file.type || undefined,
        data: new Uint8Array(await file.arrayBuffer()),
      };
    })
  );
  return inputs;
}
