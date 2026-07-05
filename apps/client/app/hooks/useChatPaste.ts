import React, { useCallback } from 'react';
import { toast } from 'sonner';
import { IFabFileDocument, ISessionDocument, KnowledgeType } from '@bike4mind/common';
import { QueryClient } from '@tanstack/react-query';
import { generateSmartFileName } from '@client/app/utils/generateSmartFileName';
import { createFabFileOnServerWithUpload } from '@client/app/utils/filesAPICalls';
import { detectContentType } from '@client/app/utils/contentTypes';
import { LexicalChatInputRef } from '@client/app/components/Session/LexicalChatInput';

interface UseChatPasteDeps {
  currentSession: ISessionDocument | null;
  currentSessionId: string | null;
  chatHistory: { prompt: string }[];
  chatInputValue: string;
  setChatInputValue: (value: string) => void;
  setWorkBenchFiles: (sessionId: string, updater: (prev: IFabFileDocument[]) => IFabFileDocument[]) => void;
  setCurrentSession: (session: ISessionDocument) => void;
  queryClient: QueryClient;
  lexicalInputRef: React.RefObject<LexicalChatInputRef | null>;
}

/**
 * Optimistically add a newly created FabFile to the file browser cache.
 */
function addToFileBrowserCache(queryClient: QueryClient, fabFile: IFabFileDocument) {
  queryClient.setQueriesData({ queryKey: ['fabFiles'] }, (oldData: unknown) => {
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
 * Insert a file tag into the Lexical editor, with fallback to string concatenation.
 */
function insertFileTag(
  fileTag: string,
  lexicalInputRef: React.RefObject<LexicalChatInputRef | null>,
  chatInputValue: string,
  setChatInputValue: (value: string) => void
) {
  if (lexicalInputRef.current) {
    try {
      lexicalInputRef.current.insertContent(fileTag);
    } catch (error) {
      console.error('Failed to insert file tag:', error);
      toast.error('Failed to add file reference to input');
      const newValue = chatInputValue.trim() ? `${chatInputValue.trim()}\n\n${fileTag}` : fileTag;
      setChatInputValue(newValue);
    }
  } else {
    const newValue = chatInputValue.trim() ? `${chatInputValue.trim()}\n\n${fileTag}` : fileTag;
    setChatInputValue(newValue);
  }
}

/**
 * Add a fab file to the workbench and update the session's knowledgeIds.
 */
function addFileToWorkbench(
  fabFile: IFabFileDocument,
  deps: Pick<UseChatPasteDeps, 'currentSessionId' | 'currentSession' | 'setWorkBenchFiles' | 'setCurrentSession'>
) {
  console.log('FabFile created with name:', fabFile.fileName);
  deps.setWorkBenchFiles(deps.currentSessionId ?? '', prev => [...prev, fabFile]);

  if (deps.currentSessionId && deps.currentSession) {
    const updatedKnowledgeIds = [...(deps.currentSession.knowledgeIds || []), fabFile.id];
    deps.setCurrentSession({ ...deps.currentSession, knowledgeIds: updatedKnowledgeIds });
  }
}

export function useChatPaste(deps: UseChatPasteDeps) {
  const {
    currentSession,
    currentSessionId,
    chatHistory,
    chatInputValue,
    setChatInputValue,
    setWorkBenchFiles,
    setCurrentSession,
    queryClient,
    lexicalInputRef,
  } = deps;

  return useCallback(
    async (e: React.ClipboardEvent<HTMLTextAreaElement> | ClipboardEvent): Promise<boolean> => {
      const clipboardData = e.clipboardData;
      if (!clipboardData) return false;
      const items = clipboardData.items;

      // Check for image paste
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          const file = item.getAsFile();
          if (file) {
            const loadingToast = toast.loading('Uploading image...');

            const smartFileName = await generateSmartFileName('', 'image', {
              hasSession: !!currentSession,
              chatHistory,
            });
            console.log('Generated smart filename for image:', smartFileName);
            const renamedFile = new File([file], smartFileName, { type: file.type });

            try {
              const fabFile = await createFabFileOnServerWithUpload(
                {
                  type: KnowledgeType.FILE,
                  fileName: renamedFile.name,
                  mimeType: renamedFile.type,
                  fileSize: renamedFile.size,
                },
                renamedFile
              );

              addFileToWorkbench(fabFile, { currentSessionId, currentSession, setWorkBenchFiles, setCurrentSession });
              addToFileBrowserCache(queryClient, fabFile);

              toast.dismiss(loadingToast);
              toast.success('Image uploaded successfully');

              const fileTag = `[[${fabFile.fileName}]]`;
              insertFileTag(fileTag, lexicalInputRef, chatInputValue, setChatInputValue);
            } catch (error) {
              queryClient.invalidateQueries({ queryKey: ['fabFiles'] });
              console.error('Failed to upload pasted image:', error);
              toast.dismiss(loadingToast);
              toast.error('Failed to upload image');
            }
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

        const loadingToast = toast.loading(`Uploading ${lines.length} lines of text as file...`);

        const smartFileName = await generateSmartFileName(pastedContent, 'text');
        console.log('Generated smart filename for text:', smartFileName);

        const blob = new Blob([pastedContent], { type: 'text/plain' });
        const file = new File([blob], smartFileName, { type: 'text/plain' });

        try {
          const fabFile = await createFabFileOnServerWithUpload(
            {
              type: KnowledgeType.FILE,
              fileName: file.name,
              mimeType: 'text/plain',
              fileSize: file.size,
            },
            file
          );

          addFileToWorkbench(fabFile, { currentSessionId, currentSession, setWorkBenchFiles, setCurrentSession });
          addToFileBrowserCache(queryClient, fabFile);

          toast.dismiss(loadingToast);
          toast.success(`Large text (${lines.length} lines) uploaded as file`);

          const fileTag = `[[${fabFile.fileName}]]`;
          insertFileTag(fileTag, lexicalInputRef, chatInputValue, setChatInputValue);
        } catch (error) {
          queryClient.invalidateQueries({ queryKey: ['fabFiles'] });
          console.error('Failed to upload pasted text as file:', error);
          toast.dismiss(loadingToast);
          toast.error('Failed to upload text as file');
        }
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
    },
    [
      currentSession,
      currentSessionId,
      chatHistory,
      chatInputValue,
      setChatInputValue,
      setWorkBenchFiles,
      setCurrentSession,
      queryClient,
      lexicalInputRef,
    ]
  );
}
