import { Request } from 'express';
import { baseApi } from '@client/server/middlewares/baseApi';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { fabFileRepository } from '@bike4mind/database';
import { isImageServeable } from '@bike4mind/common';
import axios from 'axios';

interface ProxyFabFileImageRequest {
  fabFileId: string;
}

interface ProxyFabFileImageResponse {
  success: boolean;
  imageUrl: string; // base64 data URL
  mimeType: string;
  message?: string;
}

/**
 * Proxy endpoint to download a FabFile image server-side and return as base64.
 * This avoids CORS issues when the browser tries to fetch from S3 directly.
 */
const handler = baseApi().post<Request<unknown, ProxyFabFileImageResponse, ProxyFabFileImageRequest>>(
  async (req, res) => {
    const userId = req.user!.id;
    const { fabFileId } = req.body;

    if (!fabFileId?.trim()) {
      throw new BadRequestError('FabFile ID is required');
    }

    try {
      const fabFile = await fabFileRepository.findById(fabFileId);

      if (!fabFile) {
        throw new NotFoundError('FabFile not found');
      }

      if (fabFile.userId !== userId && !fabFile.public && !fabFile.isGlobalRead) {
        throw new BadRequestError('You do not have access to this file');
      }

      if (!fabFile.mimeType?.startsWith('image/')) {
        throw new BadRequestError('File is not an image');
      }

      // Refuse to serve a held/blocked image's bytes.
      if (!isImageServeable(fabFile)) {
        throw new NotFoundError('FabFile not found');
      }

      const fileUrl = fabFile.fileUrl;
      if (!fileUrl) {
        throw new BadRequestError('File URL not available');
      }

      req.logger.info(`[Proxy FabFile] Downloading image: ${fabFile.fileName}`);
      const imageResponse = await axios.get(fileUrl, {
        responseType: 'arraybuffer',
        timeout: 30000,
      });

      const imageBuffer = Buffer.from(imageResponse.data);
      const contentType = fabFile.mimeType || imageResponse.headers['content-type'] || 'image/png';
      const base64Image = `data:${contentType};base64,${imageBuffer.toString('base64')}`;

      req.logger.info(`[Proxy FabFile] Converted to base64 (${Math.round(imageBuffer.length / 1024)}KB)`);

      res.json({
        success: true,
        imageUrl: base64Image,
        mimeType: contentType,
      });
    } catch (error) {
      req.logger.error('[Proxy FabFile] Error:', error);

      let errorMessage = 'Failed to load image. Please try again.';
      if (error instanceof Error) {
        errorMessage = error.message;
      }

      res.status(500).json({
        success: false,
        imageUrl: '',
        mimeType: '',
        message: errorMessage,
      });
    }
  }
);

export default handler;
