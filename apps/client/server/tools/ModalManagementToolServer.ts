import {
  AdminTool,
  AdminToolContext,
  AdminToolParams,
  AdminToolResult,
  ModalGenerationParams,
  IModal,
  IModalDocument,
} from '@bike4mind/common';
import { ModalModel } from '@bike4mind/database/social';
import { createModal, updateModal, deleteModal, listModals } from './modalOperations';
import { parseNaturalLanguageQueryDirect } from '@client/pages/api/admin/modal-tool';
import {
  showHelp,
  buildModalFromParams,
  generateModalFromNaturalLanguage,
  extractImagesFromChat,
  summarizeChatContext,
  suggestTags,
  aiGenerateModalContent,
  findModalByPartialId,
} from '@client/app/services/adminTools/modalToolHelpers';

/**
 * Server-side implementation of ModalManagementTool
 * Directly uses database operations - no HTTP calls
 */
export class ModalManagementToolServer implements AdminTool {
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

  // Create a new modal - directly creates in database (server-side)
  private async createModalHandler(context: AdminToolContext, params: AdminToolParams): Promise<AdminToolResult> {
    try {
      let modalData: Partial<IModal>;

      if ((params.data as ModalGenerationParams)?.fromContext && context.chatHistory) {
        modalData = await this.generateModalFromContext(context, params);
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

      // Server-side: Create directly without confirmation
      const serverParams = {
        type: modalData.isBanner ? 'banner' : 'modal',
        title: modalData.title,
        message: modalData.textMessage,
        description: modalData.description,
        priority: modalData.priority,
        enabled: modalData.enabled,
        tags: modalData.tags,
        startDate: modalData.startDate,
        endDate: modalData.endDate,
        imageUrl: modalData.imageUrl,
      };

      // Create the modal using server-side function
      const result = await createModal(serverParams);

      if (!result.success) {
        return result;
      }

      // Fetch the full modal data from database to ensure we have the processed imageUrl
      const createdModal = await ModalModel.findById(result.data?.id).lean();

      if (!createdModal) {
        return {
          success: false,
          error: 'Modal created but could not be retrieved',
        };
      }

      // Return success with trigger data using actual database values
      return {
        success: true,
        data: {
          type: 'triggerModal',
          modal: {
            id: createdModal._id?.toString(),
            title: createdModal.title || createdModal.textMessage || 'Untitled',
            description: createdModal.description,
            subtitle: createdModal.subtitle,
            textMessage: createdModal.textMessage,
            type: createdModal.isBanner ? ('banner' as const) : ('modal' as const),
            isBanner: createdModal.isBanner,
            enabled: createdModal.enabled,
            priority: createdModal.priority,
            tags: createdModal.tags || [],
            startDate: createdModal.startDate,
            endDate: createdModal.endDate,
            imageUrl: createdModal.imageUrl,
            closeButton: createdModal.closeButton,
            agreeButton: createdModal.agreeButton,
          },
        },
        message: `✅ ${createdModal.isBanner ? 'Banner' : 'Modal'} "${createdModal.title || createdModal.textMessage}" created successfully!`,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to create modal',
      };
    }
  }

  // Generate modal from chat context
  private async generateModalFromContext(context: AdminToolContext, params: AdminToolParams): Promise<Partial<IModal>> {
    const contextMessages = (params.data as ModalGenerationParams)?.contextMessages || 5;
    const recentMessages = context.chatHistory?.slice(-contextMessages) || [];

    const summary = summarizeChatContext(recentMessages);
    const images = extractImagesFromChat(recentMessages);

    const generatedContent = aiGenerateModalContent({
      summary,
      images,
      type: (params.data as ModalGenerationParams)?.type || 'modal',
      intent: params.query || '',
    });

    return {
      ...generatedContent,
      enabled: false,
      startDate: new Date().toISOString().split('T')[0],
      endDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      priority: (params.data as ModalGenerationParams)?.priority || 5,
      tags: (params.data as ModalGenerationParams)?.tags || suggestTags(generatedContent),
    };
  }

  // Update modal handler - direct database access
  private async updateModalHandler(_context: AdminToolContext, params: AdminToolParams): Promise<AdminToolResult> {
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
      // If modalId is partial (less than 24 chars), find the full ID
      let fullModalId = modalId;
      if (modalId.length < 24) {
        const allModals = await ModalModel.find({}).sort({ createdAt: -1 }).lean();
        const found = findModalByPartialId(allModals, modalId);

        if (found && found._id) {
          fullModalId = found._id.toString();
        } else if (allModals.length > 0 && allModals[0]._id) {
          fullModalId = allModals[0]._id.toString();
        } else {
          return {
            success: false,
            error: `Modal not found with ID starting with: ${modalId}`,
          };
        }
      }

      // Use server-side update function
      const result = await updateModal(fullModalId, { ...updates });

      if (!result.success) {
        return result;
      }

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

  // Delete modal - direct database access
  private async deleteModal(_context: AdminToolContext, params: AdminToolParams): Promise<AdminToolResult> {
    const modalId = (params.data as { id?: string })?.id || (params.options?.id as string);

    if (!modalId) {
      return {
        success: false,
        error: 'Modal ID is required for deletion',
      };
    }

    try {
      const result = await deleteModal(modalId);
      return result;
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to delete modal',
      };
    }
  }

  // List modals - direct database query
  private async listModals(_context: AdminToolContext, _params: AdminToolParams): Promise<AdminToolResult> {
    try {
      const modals = await ModalModel.find().lean();

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

  // Trigger/show a modal by ID or title - direct database query
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

      let modal: IModalDocument | undefined | null;

      // Try to find by ID first (full or partial)
      if (identifier.match(/^[0-9a-fA-F]{8,24}$/)) {
        if (identifier.length === 24) {
          // Full ObjectId - use findById
          modal = await ModalModel.findById(identifier).lean();
        } else {
          // Partial ID - get all modals and filter
          const allModals = await ModalModel.find({}).sort({ createdAt: -1 }).lean();
          modal = findModalByPartialId(allModals, identifier);

          if (!modal && allModals.length > 0) {
            modal = allModals[0];
          }
        }
      }

      // If not found by ID, try by title
      if (!modal) {
        modal = await ModalModel.findOne({
          title: new RegExp(identifier, 'i'),
        }).lean();
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

  // Process with LLM backend - direct server-side call
  private async processWithLLM(context: AdminToolContext, params: AdminToolParams): Promise<AdminToolResult> {
    try {
      // Query is required for LLM processing
      if (!params.query) {
        return {
          success: false,
          error: 'Query is required for natural language processing',
        };
      }

      // Call the parsing function directly
      const toolParams = await parseNaturalLanguageQueryDirect(params.query, {
        chatHistory: context.chatHistory,
        sessionId: context.sessionId,
      });

      // Execute the action using server operations directly
      let result;
      switch (toolParams.action) {
        case 'create':
          result = await createModal(toolParams);
          // Transform create result to triggerModal format so it displays
          if (result.success && result.data) {
            const createdModal = await ModalModel.findById(result.data.id).lean();
            if (createdModal) {
              return {
                success: true,
                data: {
                  type: 'triggerModal',
                  modal: {
                    id: createdModal._id?.toString(),
                    title: createdModal.title || createdModal.textMessage || 'Untitled',
                    description: createdModal.description,
                    subtitle: createdModal.subtitle,
                    textMessage: createdModal.textMessage,
                    type: createdModal.isBanner ? ('banner' as const) : ('modal' as const),
                    isBanner: createdModal.isBanner,
                    enabled: createdModal.enabled,
                    priority: createdModal.priority,
                    tags: createdModal.tags || [],
                    startDate: createdModal.startDate,
                    endDate: createdModal.endDate,
                    imageUrl: createdModal.imageUrl,
                    closeButton: createdModal.closeButton,
                    agreeButton: createdModal.agreeButton,
                  },
                },
                message: result.message,
              };
            }
          }
          break;
        case 'list':
          result = await listModals(toolParams.filter);
          break;
        case 'update':
          result = await updateModal(toolParams.modalId, toolParams);
          break;
        case 'delete':
          result = await deleteModal(toolParams.modalId);
          break;
        default:
          return { success: false, error: `Unknown action: ${toolParams.action}` };
      }

      // Return structured data for modal lists
      if (result.success && result.data && Array.isArray(result.data)) {
        const structuredModals = result.data.map((modal: Record<string, unknown>) => ({
          id: modal.id,
          title: modal.title || 'Untitled',
          content: modal.description || '',
          enabled: modal.enabled || false,
          type: modal.type || 'modal',
          priority: modal.priority || 0,
          tags: modal.tags || [],
          startDate: modal.startDate,
          endDate: modal.endDate,
          icon: modal.icon,
          primaryButtonText: modal.primaryButtonText,
          secondaryButtonText: modal.secondaryButtonText,
          dismissible: modal.dismissible,
          style: modal.style,
        }));

        return {
          success: true,
          data: {
            type: 'modalList' as const,
            modals: structuredModals,
            message: result.message || `Found ${result.data.length} modals`,
            count: result.data.length,
          },
        };
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
}
