import { Request, Response } from 'express';
import { Memento } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { MementoGroomingService } from '../../../../services/MementoGroomingService';
import { UpdateMementoSchema } from '@server/validators/mementoValidators';

const handler = baseApi().patch(async (req: Request, res: Response) => {
  req.logger.updateMetadata({ endpoint: 'mementos/[id]/update' });
  const { id } = req.query;
  let updates;
  try {
    updates = UpdateMementoSchema.parse(req.body);
  } catch (e: any) {
    return res.status(400).json({ error: e.message });
  }

  try {
    if (!id || typeof id !== 'string') {
      return res.status(400).json({ error: 'Invalid memento ID' });
    }

    const memento = await Memento.findById(id);
    if (!memento) {
      return res.status(404).json({ error: 'Memento not found' });
    }

    if (memento.userId.toString() !== req.user.id) {
      return res.status(403).json({ error: 'You do not have permission to update this memento' });
    }

    const updateData: Record<string, any> = {};

    const allowedUpdates = [
      'tier',
      'weight',
      'summary',
      'fullContent',
      'tags',
      'isArchived',
      'metadata',
      'lastAccessedAt',
    ];
    allowedUpdates.forEach(field => {
      if (updates[field as keyof typeof updates] !== undefined) {
        updateData[field] = updates[field as keyof typeof updates];
      }
    });

    // Always update lastAccessedAt when modifying a memento
    updateData.lastAccessedAt = new Date();

    const updatedMemento = await Memento.findByIdAndUpdate(id, { $set: updateData }, { new: true });

    // Tier change can shift memory limits, so re-check grooming
    if (updates.tier && updates.tier !== memento.tier) {
      const groomingService = new MementoGroomingService(req.logger);
      groomingService.checkAndScheduleGrooming(req.user.id);
    }

    return res.status(200).json(updatedMemento);
  } catch (error) {
    req.logger.error('Error updating memento:', error);
    return res.status(500).json({ error: 'Failed to update memento' });
  }
});

export default handler;
