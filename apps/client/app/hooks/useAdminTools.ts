import { useState, useCallback, useEffect } from 'react';
import { useUser } from '@client/app/contexts/UserContext';
import { toast } from 'sonner';
import { AdminToolResult, AdminToolParams, AdminToolContext } from '@bike4mind/common';
import { initializeAdminTools } from '@client/app/services/adminTools';
import { api } from '@client/app/contexts/ApiContext';

interface UseAdminToolsReturn {
  isAdmin: boolean;
  canUseAdminTools: boolean;
  executeAdminTool: (
    tool: string,
    params: AdminToolParams,
    context?: Partial<AdminToolContext>
  ) => Promise<AdminToolResult>;
  isExecuting: boolean;
  lastResult: AdminToolResult | null;
  parseCommand: (input: string) => { isAdminCommand: boolean; tool?: string; params?: AdminToolParams };
}

export function useAdminTools(): UseAdminToolsReturn {
  const { currentUser: user } = useUser();
  const [isExecuting, setIsExecuting] = useState(false);
  const [lastResult, setLastResult] = useState<AdminToolResult | null>(null);

  // Initialize admin tools on first use
  useEffect(() => {
    if (user?.isAdmin) {
      initializeAdminTools();
    }
  }, [user]);

  // Only check the isAdmin flag; there is no 'Admin' tag in VALID_USER_TAGS.
  const isAdmin = user?.isAdmin || false;
  const canUseAdminTools = isAdmin;

  // Parse command to detect admin tools
  const parseCommand = useCallback(
    (
      input: string
    ): {
      isAdminCommand: boolean;
      tool?: string;
      params?: AdminToolParams;
    } => {
      const trimmed = input.trim();

      if (trimmed.startsWith('/admin')) {
        // Handle both '/admin' alone and '/admin ' with arguments
        const hasSpace = trimmed.length > 6 && trimmed[6] === ' ';
        const command = hasSpace ? trimmed.substring(7) : ''; // Remove '/admin ' or handle just '/admin'

        const parts = command ? command.split(' ') : [];
        const tool = parts[0] || 'help'; // Default to help if no tool specified

        // For update/edit/trigger commands, pass the remaining parts as query
        const remainingParts = parts.slice(2).join(' '); // Everything after tool and action

        let action: string;
        if (tool === 'help') {
          action = 'show';
        } else if (parts.length === 1) {
          // Just "/admin <tool>" with no action - show that tool's help
          action = 'help';
        } else {
          action = parts[1] || 'help';
        }

        const params: AdminToolParams = {
          action,
          query: remainingParts || (parts.length > 1 ? command : ''), // Empty query if just tool name
          options: {},
        };

        // Parse options (--flag value)
        // Remove the action from the command before parsing flags
        // The command structure is "modal create --flags" so we need to remove "modal create"
        const commandWithoutAction = command.replace(/^(modal\s+)?create\s+/, '');

        const flagParts = commandWithoutAction.split(/\s+--/).filter(Boolean);
        for (const part of flagParts) {
          const cleanPart = part.startsWith('--') ? part.substring(2) : part;

          // Match: flagName value (value can be quoted or unquoted)
          const match = cleanPart.match(/^(\w+)\s+(.+)$/);
          if (match) {
            const flag = match[1];
            let value = match[2].trim();

            // Remove quotes if present
            if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
              value = value.slice(1, -1);
            }

            params.options![flag] = value;
          } else {
            // Flag without value (just the flag name)
            const flagMatch = cleanPart.match(/^(\w+)$/);
            if (flagMatch) {
              params.options![flagMatch[1]] = true;
            }
          }
        }

        return {
          isAdminCommand: true,
          tool: tool || 'modal', // Default to modal tool
          params,
        };
      }

      // Check for natural language admin commands
      const lower = trimmed.toLowerCase();
      if (canUseAdminTools) {
        // Detect modal/banner intent by keyword; the LLM handles the actual NL parsing.
        const modalKeywords = ['modal', 'banner', 'popup', 'notification', 'announcement', 'alert'];
        const hasModalIntent = modalKeywords.some(word => lower.includes(word));

        // Or if it's a creation request that might be for modals
        const creationPhrases = ['make a', 'create a', 'i want', 'i need', 'i would like'];
        const hasCreationPhrase = creationPhrases.some(phrase => lower.includes(phrase));

        if (hasModalIntent || hasCreationPhrase) {
          return {
            isAdminCommand: true,
            tool: 'modal',
            params: {
              action: 'process', // Let the backend figure out the actual action
              query: trimmed,
              data: {},
            },
          };
        }

        // Credit management patterns
        if (lower.includes('add') && lower.includes('credit')) {
          return {
            isAdminCommand: true,
            tool: 'credits',
            params: {
              action: 'add',
              query: trimmed,
            },
          };
        }
      }

      return { isAdminCommand: false };
    },
    [canUseAdminTools]
  );

  // Execute admin tool
  const executeAdminTool = useCallback(
    async (tool: string, params: AdminToolParams, context?: Partial<AdminToolContext>): Promise<AdminToolResult> => {
      if (!canUseAdminTools) {
        const result = {
          success: false,
          error: 'You do not have permission to use admin tools. Admin access required.',
        };
        setLastResult(result);
        toast.error('Admin access required to use this feature');
        return result;
      }

      // Double-check user is logged in
      if (!user) {
        const result = {
          success: false,
          error: 'Please log in to use admin tools',
        };
        setLastResult(result);
        toast.error('Please log in to use admin tools');
        return result;
      }

      initializeAdminTools();

      setIsExecuting(true);

      try {
        // Use api utility instead of fetch for proper auth handling
        const response = await api.post('/api/admin/tools/execute', {
          tool,
          params,
          context: {
            ...context,
            // Don't pass user from client - server will use authenticated user
          },
        });

        const result = response.data;

        setLastResult(result);

        // Show a toast, except for help which renders its content in chat.
        if (result.success) {
          if (result.type !== 'help') {
            toast.success('Admin tool executed successfully');
          }
        } else {
          toast.error(result.error || 'Admin tool execution failed');
        }

        return result;
      } catch (error: any) {
        console.error('Admin tool execution error:', error);

        let errorMessage = 'Failed to execute admin tool';

        // Handle axios errors
        if (error.response) {
          // Server responded with error status
          if (error.response.status === 401) {
            errorMessage = 'You are not authorized to use admin tools. Please ensure you are logged in as an admin.';
          } else if (error.response.data?.error) {
            errorMessage = error.response.data.error;
          } else if (error.response.data?.message) {
            errorMessage = error.response.data.message;
          } else {
            errorMessage = `Server error: ${error.response.status}`;
          }
        } else if (error.request) {
          // Request was made but no response
          errorMessage = 'No response from server. Please check your connection.';
        } else if (error.message) {
          errorMessage = error.message;
        }

        const result = {
          success: false,
          error: errorMessage,
        };

        setLastResult(result);
        toast.error(errorMessage);

        return result;
      } finally {
        setIsExecuting(false);
      }
    },
    [canUseAdminTools, user]
  );

  return {
    isAdmin,
    canUseAdminTools,
    executeAdminTool,
    isExecuting,
    lastResult,
    parseCommand,
  };
}

// Helper hook for modal-specific admin operations
export function useAdminModalTool() {
  const adminTools = useAdminTools();

  const createModalFromContext = useCallback(
    async (chatHistory: any[], type: 'modal' | 'banner' = 'modal') => {
      return adminTools.executeAdminTool(
        'modal',
        {
          action: 'create',
          data: {
            fromContext: true,
            type,
          },
        },
        {
          chatHistory,
        }
      );
    },
    [adminTools]
  );

  const createModalFromText = useCallback(
    async (text: string, type: 'modal' | 'banner' = 'modal') => {
      return adminTools.executeAdminTool('modal', {
        action: 'create',
        query: text,
        data: {
          type,
        },
      });
    },
    [adminTools]
  );

  const updateModal = useCallback(
    async (modalId: string, updates: any) => {
      return adminTools.executeAdminTool('modal', {
        action: 'update',
        data: {
          id: modalId,
          ...updates,
        },
      });
    },
    [adminTools]
  );

  const deleteModal = useCallback(
    async (modalId: string) => {
      return adminTools.executeAdminTool('modal', {
        action: 'delete',
        data: {
          id: modalId,
        },
      });
    },
    [adminTools]
  );

  return {
    ...adminTools,
    createModalFromContext,
    createModalFromText,
    updateModal,
    deleteModal,
  };
}
