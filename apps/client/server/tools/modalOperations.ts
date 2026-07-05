import { ModalModel } from '@bike4mind/database/social';
import { ModalImageHandler } from './modalImageHandler';
import { cacheExternalImage } from '@server/utils/cacheExternalImage';

// Modal operation functions that can be shared between server and API
export async function createModal(params: any) {
  try {
    const isBanner = params.type === 'banner';

    const modalData: any = {
      isBanner,
      title: isBanner ? undefined : params.title || 'New Announcement',
      textMessage: isBanner ? params.message || params.description || 'Important update' : undefined,
      description: params.description || '',
      priority: params.priority || 5,
      enabled: params.enabled || false,
      tags: params.tags || [],
      closeButton: true,
      agreeButton: !isBanner,
      startDate: params.startDate || new Date().toISOString().split('T')[0],
      endDate: params.endDate || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      imageUrl: params.imageUrl || null, // Add support for image URL
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

    // Process image URL - cache external URLs to S3 or process S3 signed URLs
    if (modalData.imageUrl) {
      const imageUrl = modalData.imageUrl;

      // For external URLs (not S3), cache them to S3
      if (!imageUrl.includes('amazonaws.com')) {
        modalData.imageUrl = await cacheExternalImage(imageUrl);
      }
      // For S3 signed URLs, convert to permanent storage
      else if (imageUrl.includes('X-Amz-Algorithm')) {
        modalData.imageUrl = await ModalImageHandler.processModalImageUrl(imageUrl);
      }
      // Otherwise it's already a permanent S3 URL, keep as-is
    }

    const modal = await ModalModel.create(modalData);

    return {
      success: true,
      message: `${isBanner ? 'Banner' : 'Modal'} created successfully`,
      data: {
        id: modal._id,
        title: modal.title || modal.textMessage,
        type: isBanner ? 'banner' : 'modal',
        enabled: modal.enabled,
        imageUrl: modal.imageUrl,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create modal',
    };
  }
}

export async function listModals(filter?: any) {
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

    // Priority filtering
    if (filter?.minPriority !== undefined || filter?.maxPriority !== undefined) {
      query.priority = {};
      if (filter.minPriority !== undefined) {
        query.priority.$gte = filter.minPriority;
      }
      if (filter.maxPriority !== undefined) {
        query.priority.$lte = filter.maxPriority;
      }
    }

    // Date range filtering
    if (filter?.dateRange) {
      if (filter.dateRange.activeOn) {
        // Modal should be active on a specific date
        const targetDate = filter.dateRange.activeOn;
        query.$and = [
          { $or: [{ startDate: { $lte: targetDate } }, { startDate: null }] },
          { $or: [{ endDate: { $gte: targetDate } }, { endDate: null }] },
        ];
      }
      if (filter.dateRange.startBefore) {
        query.startDate = { $lte: filter.dateRange.startBefore };
      }
      if (filter.dateRange.endAfter) {
        query.endDate = { $gte: filter.dateRange.endAfter };
      }
    }

    const modals = await ModalModel.find(query).sort({ createdAt: -1 }).lean();

    const formattedModals = modals.map((modal: any) => ({
      id: modal._id,
      title: modal.title || modal.textMessage || 'Untitled',
      type: modal.isBanner ? 'banner' : 'modal',
      isBanner: modal.isBanner,
      enabled: modal.enabled,
      priority: modal.priority,
      tags: modal.tags || [],
      startDate: modal.startDate,
      endDate: modal.endDate,
      description: modal.description || '',
      content: modal.description || '',
      textMessage: modal.textMessage,
      subtitle: modal.subtitle,
      imageUrl: modal.imageUrl,
      closeButton: modal.closeButton,
      agreeButton: modal.agreeButton,
      dismissible: modal.closeButton,
    }));

    return {
      success: true,
      message: `Found ${modals.length} modal(s)`,
      data: formattedModals,
      type: 'list' as const,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to list modals',
    };
  }
}

export async function updateModal(modalId: string | undefined, params: any) {
  try {
    let modal;

    // If modalId is provided, use it directly
    if (modalId && modalId.match(/^[0-9a-fA-F]{24}$/)) {
      modal = await ModalModel.findById(modalId);
    }
    // If title is provided but not modalId, try to find by title
    else if (params.title || modalId) {
      const searchTerm = params.title || modalId;
      // Try to find by title or textMessage (for banners)
      modal = await ModalModel.findOne({
        $or: [{ title: new RegExp(searchTerm, 'i') }, { textMessage: new RegExp(searchTerm, 'i') }],
      });

      if (!modal) {
        // If exact match fails, try to find partial match
        const allModals = await ModalModel.find({}).lean();
        modal = allModals.find(
          m =>
            (m.title && m.title.toLowerCase().includes(searchTerm.toLowerCase())) ||
            (m.textMessage && m.textMessage.toLowerCase().includes(searchTerm.toLowerCase()))
        );

        if (modal) {
          // Convert back to mongoose document for update
          modal = await ModalModel.findById(modal._id);
        }
      }
    }

    if (!modal) {
      return {
        success: false,
        error: `Modal not found. Please check the title or ID. Search term: "${params.title || modalId}"`,
      };
    }

    const updates: any = {};

    // Only update fields that are explicitly provided
    if (params.enabled !== undefined) updates.enabled = params.enabled;
    if (params.message !== undefined) updates.textMessage = params.message;
    if (params.description !== undefined) updates.description = params.description;
    if (params.priority !== undefined) updates.priority = params.priority;
    if (params.tags !== undefined) updates.tags = params.tags;
    if (params.startDate !== undefined) updates.startDate = params.startDate;
    if (params.endDate !== undefined) updates.endDate = params.endDate;
    if (params.imageUrl !== undefined) {
      // Process image URL - cache external URLs to S3 or process S3 signed URLs
      if (params.imageUrl) {
        const imageUrl = params.imageUrl;

        // For external URLs (not S3), cache them to S3
        if (!imageUrl.includes('amazonaws.com')) {
          updates.imageUrl = await cacheExternalImage(imageUrl);
        }
        // For S3 signed URLs, convert to permanent storage
        else if (imageUrl.includes('X-Amz-Algorithm')) {
          updates.imageUrl = await ModalImageHandler.processModalImageUrl(imageUrl);
        }
        // Otherwise it's already a permanent S3 URL, keep as-is
        else {
          updates.imageUrl = imageUrl;
        }
      } else {
        updates.imageUrl = null;
      }
    }

    // Handle tag operations
    if (params.addTags || params.removeTags) {
      // Get current tags
      const currentTags = modal.tags || [];
      let newTags = [...currentTags];

      // Add tags
      if (params.addTags && params.addTags.length > 0) {
        params.addTags.forEach((tag: string) => {
          if (!newTags.includes(tag)) {
            newTags.push(tag);
          }
        });
      }

      // Remove tags
      if (params.removeTags && params.removeTags.length > 0) {
        newTags = newTags.filter((tag: string) => !params.removeTags.includes(tag));
      }

      updates.tags = newTags;
    }

    // Don't update title if it was used for searching
    if (params.title !== undefined && modalId && modalId.match(/^[0-9a-fA-F]{24}$/)) {
      updates.title = params.title;
    }

    const updatedModal = await ModalModel.findByIdAndUpdate(modal._id, updates, { new: true });

    if (!updatedModal) {
      return { success: false, error: 'Failed to update modal' };
    }

    // Build descriptive message based on what was updated
    let actionDescription = 'updated';
    const updateDetails = [];

    if (params.enabled !== undefined) {
      actionDescription = params.enabled ? 'enabled' : 'disabled';
    } else {
      if (params.priority !== undefined) updateDetails.push(`priority set to ${params.priority}`);
      if (params.startDate !== undefined) updateDetails.push(`start date set to ${params.startDate}`);
      if (params.endDate !== undefined) updateDetails.push(`end date set to ${params.endDate}`);
      if (params.addTags && params.addTags.length > 0) updateDetails.push(`tags added: ${params.addTags.join(', ')}`);
      if (params.removeTags && params.removeTags.length > 0)
        updateDetails.push(`tags removed: ${params.removeTags.join(', ')}`);
      if (params.message !== undefined) updateDetails.push('message updated');
      if (params.description !== undefined) updateDetails.push('description updated');

      if (updateDetails.length > 0) {
        actionDescription = `updated (${updateDetails.join(', ')})`;
      }
    }

    return {
      success: true,
      message: `Modal "${updatedModal.title || updatedModal.textMessage}" ${actionDescription} successfully`,
      data: {
        id: updatedModal._id,
        title: updatedModal.title || updatedModal.textMessage,
        type: updatedModal.isBanner ? 'banner' : 'modal',
        enabled: updatedModal.enabled,
        priority: updatedModal.priority,
        tags: updatedModal.tags,
        startDate: updatedModal.startDate,
        endDate: updatedModal.endDate,
        imageUrl: updatedModal.imageUrl,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to update modal',
    };
  }
}

export async function deleteModal(modalId: string | undefined) {
  if (!modalId) {
    return { success: false, error: 'Modal ID required for deletion' };
  }

  try {
    const modal = await ModalModel.findByIdAndDelete(modalId);

    if (!modal) {
      return { success: false, error: 'Modal not found' };
    }

    return {
      success: true,
      message: 'Modal deleted successfully',
      data: {
        id: modal._id,
        title: modal.title || modal.textMessage,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to delete modal',
    };
  }
}
