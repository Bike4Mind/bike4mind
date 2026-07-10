import React, { createContext, useContext, ReactNode } from 'react';
import { useSubscribeChatCompletion, IChatCompletion } from '@client/app/hooks/useSubscribeChatCompletion';

interface ChatCompletionContextType {
  chatCompletion: IChatCompletion;
  setChatCompletion: React.Dispatch<React.SetStateAction<IChatCompletion>>;
}

const ChatCompletionContext = createContext<ChatCompletionContextType | undefined>(undefined);

export const useChatCompletionContext = (): ChatCompletionContextType => {
  const context = useContext(ChatCompletionContext);
  if (!context) {
    throw new Error('useChatCompletionContext must be used within a ChatCompletionProvider');
  }
  return context;
};

/**
 * Mounts a single `useSubscribeChatCompletion` subscription for the routed
 * session and shares it between SessionMiddle and SessionBottom, which
 * previously each mounted their own copy - doubling the [QUEST-DROP] volume
 * from an in-flight foreign session's chunks and doubling subscription churn
 * on every session switch.
 */
export const ChatCompletionProvider: React.FC<{ sessionId: string | null; children: ReactNode }> = ({
  sessionId,
  children,
}) => {
  const value = useSubscribeChatCompletion(sessionId);

  return <ChatCompletionContext.Provider value={value}>{children}</ChatCompletionContext.Provider>;
};
