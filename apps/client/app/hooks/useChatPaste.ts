import React, { useCallback, useRef } from 'react';
import { toast } from 'sonner';
import { IFabFileDocument, ISessionDocument, isImageAttachment } from '@bike4mind/common';
import { QueryClient } from '@tanstack/react-query';
import { generateSmartFileName } from '@client/app/utils/generateSmartFileName';
import { detectContentType } from '@client/app/utils/contentTypes';
import { LexicalChatInputRef } from '@client/app/components/Session/LexicalChatInput';
import { fabFileKeys } from '@client/app/hooks/data/fabFileKeys';
import {
  ComposerUploadContext,
  uploadComposerFile,
} from '@client/app/components/Session/SessionBottom/uploadComposerFile';

interface UseChatPasteDeps extends ComposerUploadContext {
  currentSession: ISessionDocument | null;
  chatHistory: { prompt: string }[];
  chatInputValue: string;
  setChatInputValue: (value: string) => void;
  lexicalInputRef: React.RefObject<LexicalChatInputRef | null>;
}

/**
 * Optimistically add a newly created FabFile to the file browser cache.
 */
function addToFileBrowserCache(queryClient: QueryClient, fabFile: IFabFileDocument) {
  queryClient.setQueriesData({ queryKey: fabFileKeys.all }, (oldData: unknown) => {
    const data = oldData as { pages?: { data: IFabFileDocument[]; total: number }[] } | undefined;
    if (!data?.pages?.[0]?.data) return oldData;
    return {
      ...data,
      pages: data.pages.map((page, index) => {
        if (index === 0) {
          return {
            ...page,
            data: [fabFile, ...page.data],
            total: page.total + 1,
          };
        }
        return page;
      }),
    };
  });
}

/**
 * Upload a pasted file through the same pipeline as dropped/picked files, so it gets a
 * composer thumbnail, moderation state and attach scope.
 */
async function uploadPastedFile(file: File, deps: UseChatPasteDeps) {
  const { queryClient } = deps;
  try {
    const fabFile = await uploadComposerFile(file, deps);
    addToFileBrowserCache(queryClient, fabFile);
  } catch {
    // The failure is shown on the file's tile (uploadComposerFile marks it errored).
    queryClient.invalidateQueries({ queryKey: fabFileKeys.all });
  }
}

export function useChatPaste(deps: UseChatPasteDeps) {
  // Latest-ref so the returned handler is permanently stable. PasteHandlerPlugin
  // keys its PASTE_COMMAND registration on the identity, and `chatInputValue` /
  // `chatHistory` change on every keystroke - as a dep array that re-registered
  // the command once per character typed. Reading at fire time is also strictly
  // more correct for a paste handler: it sees the current draft, not the draft as
  // of the render that produced the handler.
  const depsRef = useRef(deps);
  // eslint-disable-next-line react-hooks/refs
  depsRef.current = deps;

  return useCallback(async (e: React.ClipboardEvent<HTMLTextAreaElement> | ClipboardEvent): Promise<boolean> => {
    const latest = depsRef.current;
    const { currentSession, chatHistory, chatInputValue, setChatInputValue, lexicalInputRef } = latest;

    const clipboardData = e.clipboardData;
    if (!clipboardData) return false;
    const items = clipboardData.items;

    // Check for image paste
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (isImageAttachment(item.type)) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) {
          const smartFileName = await generateSmartFileName('', 'image', {
            hasSession: !!currentSession,
            chatHistory,
          });
          await uploadPastedFile(new File([file], smartFileName, { type: file.type }), latest);
          return true;
        }
      }
    }

    // Check for text paste
    const pastedContent = clipboardData.getData('text');
    const lines = pastedContent.split('\n');

    // if already wrapped with snippet meta, skip processing
    if (pastedContent.includes('<!--snippet-meta')) {
      return false;
    }

    // Handle large text (more than 30 lines) as file upload
    if (lines.length > 30) {
      e.preventDefault();

      const smartFileName = await generateSmartFileName(pastedContent, 'text');
      const file = new File([pastedContent], smartFileName, { type: 'text/plain' });
      await uploadPastedFile(file, latest);
      return true;
    }

    // Original behavior for smaller text (20-30 lines) - create code block
    if (lines.length > 20) {
      e.preventDefault();

      const contentType = detectContentType(pastedContent);
      const contentWithNewline = pastedContent.endsWith('\n') ? pastedContent : `${pastedContent}\n`;
      const codeBlock = `\`\`\`${contentType}\n${contentWithNewline}\`\`\``;

      if (lexicalInputRef.current) {
        try {
          lexicalInputRef.current.insertContent(codeBlock);
        } catch (error) {
          console.error('Failed to insert code block:', error);
          toast.error('Failed to add code block to input');
          const newValue = chatInputValue.trim() ? `${chatInputValue.trim()}\n\n${codeBlock}` : codeBlock;
          setChatInputValue(newValue);
        }
      } else {
        const newValue = chatInputValue.trim() ? `${chatInputValue.trim()}\n\n${codeBlock}` : codeBlock;
        setChatInputValue(newValue);
      }

      return true;
    }

    // Small text - let Lexical handle it normally
    return false;
  }, []);
}
