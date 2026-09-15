import { z } from 'zod';
import { ModalModel } from '@bike4mind/database/social';
import { IModalDocument } from '@bike4mind/common';

// Tool schema for LLM to understand parameters
export const modalManagementToolSchema = z.object({
  action: z.enum(['create', 'list', 'update', 'delete', 'preview']).describe('The action to perform on modals'),

  // For create/update
  title: z.string().optional().describe('Title of the modal (for modals, not banners)'),
  description: z.string().optional().describe('Description or main content of the modal/banner'),
  message: z.string().optional().describe('Text message for banners'),
  type: z.enum(['modal', 'banner']).prefault('modal').describe('Whether to create a modal popup or a banner'),
  priority: z.number().min(0).max(10).prefault(5).describe('Display priority (0-10, higher = more important)'),
  enabled: z.boolean().prefault(false).describe('Whether the modal/banner is active'),
  tags: z.array(z.string()).prefault([]).describe('User tags to target specific groups'),
  startDate: z.string().optional().describe('Start date in YYYY-MM-DD format'),
  endDate: z.string().optional().describe('End date in YYYY-MM-DD format'),

  // For update/delete/preview
  modalId: z.string().optional().describe('ID of the modal to update, delete, or preview'),

  // For list
  filter: z
    .object({
      enabled: z.boolean().optional(),
      type: z.enum(['modal', 'banner']).optional(),
      tags: z.array(z.string()).optional(),
    })
    .optional()
    .describe('Filters for listing modals'),
});

export type ModalManagementParams = z.infer<typeof modalManagementToolSchema>;

/**
 * Modal Management Tool - LLM-callable tool for managing modals and banners
 * This tool can be exposed via MCP for natural language modal management
 */
export const modalManagementTool = {
  name: 'modal_management',
  description: `Manage modals and banners in the system. Can create, list, update, and delete modals/banners. 
    Use natural language to describe what you want - the tool will understand context like:
    - "Create a banner saying hello world" 
    - "Make a welcome modal for new users"
    - "List all active banners"
    - "Create a maintenance notification"`,

  inputSchema: modalManagementToolSchema,

  execute: async (params: ModalManagementParams, context?: { user?: any }) => {
    // Validate user permissions
    if (context?.user && !context.user.isAdmin) {
      return {
        success: false,
        error: 'Admin permissions required for modal management',
      };
    }

    switch (params.action) {
      case 'create':
        return await createModal(params);

      case 'list':
        return await listModals(params.filter);

      case 'update':
        if (!params.modalId) {
          return { success: false, error: 'Modal ID required for update' };
        }
        return await updateModal(params.modalId, params);

      case 'delete':
        if (!params.modalId) {
          return { success: false, error: 'Modal ID required for deletion' };
        }
        return await deleteModal(params.modalId);

      case 'preview':
        if (!params.modalId) {
          return { success: false, error: 'Modal ID required for preview' };
        }
        return await previewModal(params.modalId);

      default:
        return { success: false, error: 'Invalid action' };
    }
  },
};

async function createModal(params: ModalManagementParams) {
  try {
    const isBanner = params.type === 'banner';

    // Smart defaults based on type
    const modalData: Partial<IModalDocument> = {
      isBanner,
      title: params.title || 'Announcement',
      textMessage: isBanner ? params.message || params.description || 'Important update' : undefined,
      description: params.description || '',
      priority: params.priority || 5,
      enabled: params.enabled || false,
      tags: params.tags || [],
      closeButton: true,
      agreeButton: !isBanner,
      startDate: params.startDate || new Date().toISOString().split('T')[0],
      endDate: params.endDate || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      numberOfViews: {
        type: 'standardView',
        value: 0,
        threshold: 3,
        tags: [],
      },
      numberOfAgrees: {
        type: 'standardAgree',
        value: 0,
        threshold: 1,
        tags: [],
      },
    };

    const modal = await ModalModel.create(modalData);

    return {
      success: true,
      message: `${isBanner ? 'Banner' : 'Modal'} created successfully`,
      data: {
        id: modal._id,
        title: modal.title || modal.textMessage,
        type: isBanner ? 'banner' : 'modal',
        enabled: modal.enabled,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create modal',
    };
  }
}

async function listModals(filter?: any) {
  try {
    const query: any = {};

    if (filter?.enabled !== undefined) {
      query.enabled = filter.enabled;
    }

    if (filter?.type) {
      query.isBanner = filter.type === 'banner';
    }

    if (filter?.tags && filter.tags.length > 0) {
      query.tags = { $in: filter.tags };
    }

    const modals = await ModalModel.find(query).lean();

    const formattedModals = modals.map((modal: any) => ({
      id: modal._id,
      title: modal.title || modal.textMessage || 'Untitled',
      type: modal.isBanner ? 'banner' : 'modal',
      enabled: modal.enabled,
      priority: modal.priority,
      tags: modal.tags || [],
      dates: `${modal.startDate || 'No start'} to ${modal.endDate || 'No end'}`,
      description: modal.description
        ? modal.description.substring(0, 100) + (modal.description.length > 100 ? '...' : '')
        : 'No description',
    }));

    return {
      success: true,
      message: `Found ${modals.length} modal(s)`,
      data: formattedModals,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to list modals',
    };
  }
}

async function updateModal(modalId: string, params: ModalManagementParams) {
  try {
    const updates: any = {};

    if (params.title !== undefined) updates.title = params.title;
    if (params.description !== undefined) updates.description = params.description;
    if (params.message !== undefined) updates.textMessage = params.message;
    if (params.priority !== undefined) updates.priority = params.priority;
    if (params.enabled !== undefined) updates.enabled = params.enabled;
    if (params.tags !== undefined) updates.tags = params.tags;
    if (params.startDate !== undefined) updates.startDate = params.startDate;
    if (params.endDate !== undefined) updates.endDate = params.endDate;

    const modal = await ModalModel.findByIdAndUpdate(modalId, updates, { new: true });

    if (!modal) {
      return { success: false, error: 'Modal not found' };
    }

    return {
      success: true,
      message: 'Modal updated successfully',
      data: {
        id: modal._id,
        title: modal.title || modal.textMessage,
        enabled: modal.enabled,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to update modal',
    };
  }
}

async function deleteModal(modalId: string) {
  try {
    const modal = await ModalModel.findByIdAndDelete(modalId);

    if (!modal) {
      return { success: false, error: 'Modal not found' };
    }

    return {
      success: true,
      message: 'Modal deleted successfully',
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to delete modal',
    };
  }
}

async function previewModal(modalId: string) {
  try {
    const modal = await ModalModel.findById(modalId).lean();

    if (!modal) {
      return { success: false, error: 'Modal not found' };
    }

    return {
      success: true,
      message: 'Modal preview',
      data: modal,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to preview modal',
    };
  }
}

// Export for MCP registration
export default modalManagementTool;
