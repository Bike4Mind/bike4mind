import {
  AdminTool,
  AdminToolContext,
  AdminToolParams,
  AdminToolResult,
  ModalGenerationParams,
  IModal,
  IModalDocument,
  ActionParams,
} from '@bike4mind/common';
import { createModal, updateModal, deleteModalFromServer } from '@client/app/utils/modalsAPICalls';
import {
  showHelp,
  buildModalFromParams,
  generateModalFromNaturalLanguage,
  generateModalContentFromContext,
  NO_CHAT_CONTEXT_MESSAGE,
  suggestTags,
} from './modalToolHelpers';

/**
 * Client-side implementation of ModalManagementTool
 * Uses HTTP calls only - no server-side imports
 */
export class ModalManagementToolClient implements AdminTool {
  name = 'modal';
  description = 'Create, edit, and manage modals and banners using natural language';
  command = '/admin modal';
  requiredPermissions = ['manage_modals'];
  requiresAdmin = true;

  handler = async (context: AdminToolContext, params: AdminToolParams): Promise<AdminToolResult> => {
    const { action, query } = params;

    // If action is 'modal' (same as tool name) or empty/help, show help
    if (!action || action === 'help' || action === 'show' || action === 'modal') {
      const lowerQuery = (query || '').toLowerCase().trim();
      if (!lowerQuery || lowerQuery === 'modal' || lowerQuery === 'help') {
        return showHelp();
      }
    }

    switch (action) {
      case 'help':
        return showHelp();

      case 'process':
        return await this.processWithLLM(context, params);

      case 'from-context':
        return await this.createModalHandler(context, {
          ...params,
          data: {
            ...params.data,
            fromContext: true,
          },
        });

      case 'create':
        // If the query contains natural language (not flags), use LLM processing
        if (
          query &&
          !query.includes('--') &&
          (query.includes('modal') || query.includes('banner') || query.includes('that') || query.includes('announces'))
        ) {
          params.query = `create ${query}`;
          return await this.processWithLLM(context, params);
        }
        return await this.createModalHandler(context, params);

      case 'edit':
      case 'update':
        return await this.updateModalHandler(context, params);

      case 'delete':
        return await this.deleteModal(context, params);

      case 'list':
        return await this.listModals(context, params);

      case 'preview':
        return await this.previewModal(context, params);

      case 'trigger':
      case 'show':
        return await this.triggerModal(context, params);

      default:
        // Try natural language processing
        if (query) {
          const lowerQuery = query.toLowerCase();
          if (lowerQuery.includes('show') || lowerQuery.includes('trigger') || lowerQuery.includes('display')) {
            const words = query.split(' ');
            const identifier = words[words.length - 1];
            if (identifier && identifier !== 'modal' && identifier !== 'banner') {
              params.query = identifier;
              return await this.triggerModal(context, params);
            }
          }
          return await this.processWithLLM(context, params);
        }

        return {
          success: false,
          error: 'Unknown action. Try: create, edit, delete, list, or use natural language.',
        };
    }
  };

  // Create a new modal - returns preview for confirmation, then uses HTTP API
  private async createModalHandler(context: AdminToolContext, params: AdminToolParams): Promise<AdminToolResult> {
    try {
      let modalData: Partial<IModal>;

      // from-context always builds from recent chat; if there is none we return
      // a clear message rather than falling back to any query text below.
      if ((params.data as ModalGenerationParams)?.fromContext) {
        const contextModal = await this.generateModalFromContext(context, params);
        if (!contextModal) {
          return {
            success: false,
            error: NO_CHAT_CONTEXT_MESSAGE,
          };
        }
        modalData = contextModal;
      } else if (params.query) {
        modalData = generateModalFromNaturalLanguage(
          params.query,
          params.data as Record<string, unknown>,
          params.options,
          context.attachments
        );

        if (params.options?.image && !modalData.imageUrl) {
          modalData.imageUrl = params.options.image as string;
        }
      } else {
        modalData = buildModalFromParams(params);
      }

      // Client-side: Return preview for confirmation
      return {
        success: true,
        preview: {
          type: modalData.isBanner ? 'banner' : 'modal',
          content: modalData.isBanner
            ? {
                type: 'banner' as const,
                message: modalData.textMessage || modalData.title || '',
                priority: modalData.priority || 5,
                tags: modalData.tags || [],
              }
            : {
                type: 'modal' as const,
                modal: modalData,
              },
          editable: true,
        },
        requiresConfirmation: true,
        nextAction: {
          type: 'confirm',
          handler: async (confirmParams: ActionParams): Promise<AdminToolResult> => {
            // Apply any edits from confirmation
            const edits =
              confirmParams.action === 'confirm'
                ? (confirmParams.data as { edits?: Partial<IModal> })?.edits
                : undefined;
            const finalModal = { ...modalData, ...edits };

            // Create the modal via HTTP
            const created = await createModal(finalModal as IModal);

            // Auto-trigger the modal to show it
            return {
              success: true,
              data: {
                type: 'triggerModal',
                modal: {
                  ...finalModal,
                  id: created._id || (created as { id?: string }).id,
                  type: finalModal.isBanner ? ('banner' as const) : ('modal' as const),
                },
              },
              message: `✅ ${finalModal.isBanner ? 'Banner' : 'Modal'} "${finalModal.title}" created successfully!`,
            };
          },
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to create modal',
      };
    }
  }

  // Generate modal from chat context. Returns null when there is no usable
  // recent context so the caller can surface a clear message.
  private async generateModalFromContext(
    context: AdminToolContext,
    params: AdminToolParams
  ): Promise<Partial<IModal> | null> {
    const contextMessages = (params.data as ModalGenerationParams)?.contextMessages || 5;
    const recentMessages = context.chatHistory?.slice(-contextMessages) || [];

    const generatedContent = generateModalContentFromContext(recentMessages, {
      type: (params.data as ModalGenerationParams)?.type || 'modal',
      intent: params.query || '',
    });

    if (!generatedContent) {
      return null;
    }

    return {
      ...generatedContent,
      enabled: false,
      startDate: new Date().toISOString().split('T')[0],
      endDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      priority: (params.data as ModalGenerationParams)?.priority || 5,
      tags: (params.data as ModalGenerationParams)?.tags || suggestTags(generatedContent),
    };
  }

  // Update modal handler - uses HTTP API
  private async updateModalHandler(context: AdminToolContext, params: AdminToolParams): Promise<AdminToolResult> {
    let modalId = (params.data as { id?: string })?.id || (params.options?.id as string);
    let updates: Partial<IModal> = {};

    // If no modalId from structured params, try to parse from query
    if (!modalId && params.query) {
      const query = params.query.trim();

      // Try to extract modal ID (8-24 hex characters at the beginning)
      const idMatch = query.match(/^([0-9a-fA-F]{8,24})\s+/);
      if (idMatch) {
        modalId = idMatch[1];
        const remainingQuery = query.substring(idMatch[0].length);

        // Parse update fields from remaining query
        if (remainingQuery.includes(' to ')) {
          const [field, ...valueParts] = remainingQuery.split(' to ');
          const fieldName = field.trim().toLowerCase();
          let value: string | boolean | number = valueParts.join(' to ').trim();

          // Remove quotes if present
          if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
          }

          // Convert boolean strings
          if (value === 'true') value = true;
          if (value === 'false') value = false;

          // Convert numbers for priority
          if (fieldName === 'priority' && !isNaN(Number(value))) {
            value = Number(value);
          }

          // Map field names to modal properties
          const fieldMap: Record<string, string> = {
            title: 'title',
            content: 'content',
            description: 'description',
            enabled: 'enabled',
            priority: 'priority',
            type: 'isBanner',
          };

          if (fieldMap[fieldName]) {
            if (fieldName === 'type') {
              updates.isBanner = String(value).toLowerCase() === 'banner';
            } else {
              (updates as Record<string, unknown>)[fieldMap[fieldName]] = value;
            }
          } else {
            (updates as Record<string, unknown>)[fieldName] = value;
          }
        }
      }
    }

    if (!modalId) {
      return {
        success: false,
        error: 'Modal ID is required for update. Use format: /admin modal update [ID] [field] to [value]',
      };
    }

    // If no updates were parsed from query, use buildModalFromParams
    if (Object.keys(updates).length === 0) {
      updates = buildModalFromParams(params);
    }

    try {
      // For partial IDs, we need to fetch all modals and find the match
      let fullModalId = modalId;
      if (modalId.length < 24) {
        // Fetch modals and find by partial ID
        const modals = await this.fetchModals();
        const found = modals.find(m => {
          const idStr = (m._id?.toString() || '').toLowerCase();
          const searchId = modalId.toLowerCase();
          return idStr.startsWith(searchId) || idStr.endsWith(searchId);
        });

        if (found && found._id) {
          fullModalId = found._id.toString();
        } else if (modals.length > 0 && modals[0]._id) {
          fullModalId = modals[0]._id.toString();
        } else {
          return {
            success: false,
            error: `Modal not found with ID starting with: ${modalId}`,
          };
        }
      }

      // Update via HTTP
      await updateModal(fullModalId, updates);

      return {
        success: true,
        message: `✅ Modal ${modalId.slice(0, 8)} updated successfully!`,
        data: { modalId: fullModalId, updates },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to update modal',
      };
    }
  }

  // Delete modal - returns confirmation dialog
  private async deleteModal(_context: AdminToolContext, params: AdminToolParams): Promise<AdminToolResult> {
    const modalId = (params.data as { id?: string })?.id || (params.options?.id as string);

    if (!modalId) {
      return {
        success: false,
        error: 'Modal ID is required for deletion',
      };
    }

    return {
      success: true,
      requiresConfirmation: true,
      preview: {
        type: 'data',
        content: {
          type: 'data',
          data: { modalId, action: 'delete' },
          format: 'list' as const,
        },
      },
      nextAction: {
        type: 'confirm',
        handler: async () => {
          await deleteModalFromServer(modalId);
          return {
            success: true,
            data: { deleted: modalId },
          };
        },
      },
    };
  }

  // List modals - fetches via HTTP
  private async listModals(_context: AdminToolContext, _params: AdminToolParams): Promise<AdminToolResult> {
    try {
      const modals = await this.fetchModals();

      if (!modals || modals.length === 0) {
        return {
          success: true,
          type: 'list',
          message: 'No modals found',
          data: 'No modals have been created yet. Use `/admin modal create` to create your first modal.',
        };
      }

      const structuredModals = modals.map((modal: IModalDocument) => ({
        id: modal._id ? modal._id.toString() : '',
        title: modal.title || modal.textMessage || 'Untitled',
        content: modal.description || '',
        enabled: modal.enabled || false,
        type: modal.isBanner ? ('banner' as const) : ('modal' as const),
        priority: modal.priority || 0,
        tags: modal.tags || [],
        startDate: modal.startDate,
        endDate: modal.endDate,
        imageUrl: modal.imageUrl,
        dismissible: modal.closeButton,
      }));

      return {
        success: true,
        data: {
          type: 'modalList' as const,
          modals: structuredModals,
          message: `Found ${modals.length} modal${modals.length !== 1 ? 's' : ''}`,
          count: modals.length,
        },
      };
    } catch (error) {
      console.error('Error fetching modals:', error);
      return {
        success: false,
        error: `Failed to fetch modals: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }

  // Preview modal
  private async previewModal(_context: AdminToolContext, params: AdminToolParams): Promise<AdminToolResult> {
    const modalId = (params.data as { id?: string })?.id || (params.options?.id as string);

    if (!modalId) {
      return {
        success: false,
        error: 'Modal ID is required for preview',
      };
    }

    return {
      success: true,
      preview: {
        type: 'modal',
        content: {
          type: 'modal',
          modal: { _id: modalId } as Partial<IModal>,
        },
        editable: false,
      },
    };
  }

  // Trigger/show a modal by ID or title
  private async triggerModal(_context: AdminToolContext, params: AdminToolParams): Promise<AdminToolResult> {
    try {
      let identifier = (params.data as { id?: string })?.id || (params.options?.id as string) || params.query?.trim();

      if (identifier && identifier.includes('modal trigger')) {
        const parts = identifier.split(' ');
        identifier = parts[parts.length - 1];
      }

      if (!identifier) {
        return {
          success: false,
          error: 'Modal ID or title is required to trigger a modal',
        };
      }

      // Fetch modals via HTTP
      const modals = await this.fetchModals();
      let modal: IModalDocument | undefined;

      // Try to find by ID (full or partial) or title
      if (identifier.match(/^[0-9a-fA-F]{8,24}$/)) {
        if (identifier.length === 24) {
          modal = modals.find(m => m._id?.toString() === identifier);
        } else {
          modal = modals.find(m => {
            if (!m._id) return false;
            const idStr = m._id.toString().toLowerCase();
            const searchId = identifier!.toLowerCase();
            return idStr.startsWith(searchId) || idStr.endsWith(searchId);
          });

          if (!modal && modals.length > 0) {
            modal = modals[0];
          }
        }
      }

      // If not found by ID, try by title
      if (!modal) {
        modal = modals.find(m => m.title?.toLowerCase().includes(identifier!.toLowerCase()));
      }

      if (!modal) {
        return {
          success: false,
          error: `Modal not found with identifier: "${identifier}". Please check the ID or try using the modal title instead.`,
        };
      }

      return {
        success: true,
        data: {
          type: 'triggerModal',
          modal: {
            id: modal._id ? modal._id.toString() : '',
            title: modal.title || modal.textMessage || 'Untitled',
            content: modal.description || '',
            description: modal.description || '',
            enabled: modal.enabled || false,
            type: modal.isBanner ? ('banner' as const) : ('modal' as const),
            priority: modal.priority || 0,
            tags: modal.tags || [],
            startDate: modal.startDate,
            endDate: modal.endDate,
            imageUrl: modal.imageUrl,
            dismissible: modal.closeButton,
            isBanner: modal.isBanner,
            closeButton: modal.closeButton,
            agreeButton: modal.agreeButton,
            subtitle: modal.subtitle,
            textMessage: modal.textMessage,
          },
        },
      };
    } catch (error) {
      console.error('Error triggering modal:', error);
      return {
        success: false,
        error: `Failed to trigger modal: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }

  // Process with LLM backend via HTTP
  private async processWithLLM(context: AdminToolContext, params: AdminToolParams): Promise<AdminToolResult> {
    try {
      const url = `${window.location.origin}/api/admin/modal-tool`;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({
          query: params.query,
          context: {
            chatHistory: context.chatHistory,
            sessionId: context.sessionId,
          },
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('API error response:', errorText);
        throw new Error(`API call failed: ${response.status} ${response.statusText}`);
      }

      const result = await response.json();

      if (result.success && result.data) {
        if (Array.isArray(result.data)) {
          return {
            success: true,
            data: {
              type: 'modalList',
              modals: result.data,
              message: result.message,
              count: result.data.length,
            },
          };
        } else {
          return {
            success: true,
            message: result.message || 'Modal operation completed successfully',
            data: result.data,
          };
        }
      }

      return result;
    } catch (error) {
      console.error('LLM modal processing error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to process modal request',
      };
    }
  }

  // Helper to fetch modals via HTTP
  private async fetchModals(): Promise<IModalDocument[]> {
    const response = await fetch('/api/modals', {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
      credentials: 'include',
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch modals: ${response.statusText}`);
    }

    return (await response.json()) as IModalDocument[];
  }
}
