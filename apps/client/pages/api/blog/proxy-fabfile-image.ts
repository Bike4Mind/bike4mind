import { Request } from 'express';
import { baseApi } from '@client/server/middlewares/baseApi';
import { BadGatewayError, BadRequestError, NotFoundError, isImageServeable } from '@bike4mind/common';
import { fabFileRepository } from '@bike4mind/database';
import axios, { type AxiosResponse } from 'axios';

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

    // Validation errors propagate to `errorHandler`, which answers 4xx and logs them at warn.
    const fabFile = await fabFileRepository.findById(fabFileId);

    // A file the caller cannot read answers exactly like a missing one, so the route never
    // confirms that an id exists.
    const canRead = fabFile && (fabFile.userId === userId || fabFile.public || fabFile.isGlobalRead);
    // Refuse to serve a held/blocked image's bytes.
    if (!fabFile || !canRead || !isImageServeable(fabFile)) {
      throw new NotFoundError('FabFile not found');
    }

    if (!fabFile.mimeType?.startsWith('image/')) {
      throw new BadRequestError('File is not an image');
    }

    const fileUrl = fabFile.fileUrl;
    if (!fileUrl) {
      throw new BadRequestError('File URL not available');
    }

    req.logger.info(`[Proxy FabFile] Downloading image: ${fabFile.fileName}`);
    let imageResponse: AxiosResponse<ArrayBuffer>;
    try {
      imageResponse = await axios.get<ArrayBuffer>(fileUrl, {
        responseType: 'arraybuffer',
        timeout: 30000,
      });
    } catch (error) {
      // The upstream detail stays in the log; `errorHandler` records the 502 itself at error.
      req.logger.warn(
        `[Proxy FabFile] Image download failed: ${error instanceof Error ? error.message : String(error)}`
      );
      throw new BadGatewayError('Failed to load image. Please try again.');
    }

    const imageBuffer = Buffer.from(imageResponse.data);
    const contentType = fabFile.mimeType || imageResponse.headers['content-type'] || 'image/png';
    const base64Image = `data:${contentType};base64,${imageBuffer.toString('base64')}`;

    req.logger.info(`[Proxy FabFile] Converted to base64 (${Math.round(imageBuffer.length / 1024)}KB)`);

    res.json({
      success: true,
      imageUrl: base64Image,
      mimeType: contentType,
    });
  }
);

export default handler;
