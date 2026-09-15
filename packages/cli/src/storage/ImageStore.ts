import { createHash } from 'crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'fs';
import { join, extname, resolve } from 'path';
import { homedir } from 'os';
import Database from 'better-sqlite3';
import sharp from 'sharp';

export interface ImageMetadata {
  hash: string;
  format: string;
  size: number;
  timestamp: number;
  uploaded: boolean;
  s3Url?: string;
  originalFilename?: string;
}

export interface ImageReference {
  hash: string;
  placeholder: string; // e.g., "[Image 1]"
  localPath: string;
  metadata: ImageMetadata;
}

/**
 * Local image cache for CLI
 * Stores pasted/dropped images before upload to S3
 */
export class ImageStore {
  private static readonly BASE_DIR = join(homedir(), '.bike4mind', 'cli');
  private static readonly IMAGES_DIR = join(ImageStore.BASE_DIR, 'images');
  private static readonly DB_PATH = join(ImageStore.BASE_DIR, 'images.db');
  private static readonly RETENTION_DAYS = 7;
  // Target max size before base64 encoding. Base64 adds ~33% overhead.
  // To stay under 1MB after base64, we need images < 750KB
  private static readonly MAX_RAW_SIZE = 750 * 1024; // 750KB
  // Maximum size before compression to prevent OOM with very large images
  private static readonly MAX_PRECOMPRESS_SIZE = 50 * 1024 * 1024; // 50MB

  private db: Database.Database;

  constructor() {
    this.ensureDirectories();
    this.db = new Database(ImageStore.DB_PATH);
    this.initDatabase();
    try {
      this.cleanupOldImages();
    } catch (err) {
      console.warn('Failed to cleanup old images:', err);
    }
  }

  private ensureDirectories(): void {
    mkdirSync(ImageStore.BASE_DIR, { recursive: true });
    mkdirSync(ImageStore.IMAGES_DIR, { recursive: true });
  }

  private initDatabase(): void {
    this.db.exec(`
			CREATE TABLE IF NOT EXISTS images (
				hash TEXT PRIMARY KEY,
				format TEXT NOT NULL,
				size INTEGER NOT NULL,
				timestamp INTEGER NOT NULL,
				uploaded INTEGER NOT NULL DEFAULT 0,
				s3_url TEXT,
				original_filename TEXT
			)
		`);
  }

  /**
   * Store an image locally with content-based hashing for deduplication
   */
  async store(imageData: Buffer, originalFilename?: string): Promise<ImageReference> {
    // Compress image if needed to stay under size limit
    const { buffer: processedData, format: processedFormat } = await this.processImage(imageData, originalFilename);

    const hash = this.generateHash(processedData);
    const format = processedFormat;
    const ext = format.toLowerCase();
    const localPath = join(ImageStore.IMAGES_DIR, `${hash}.${ext}`);

    // Check if already exists
    const existing = this.getMetadata(hash);
    if (existing) {
      return {
        hash,
        placeholder: '', // Will be set by caller
        localPath,
        metadata: existing,
      };
    }

    // Save to disk
    writeFileSync(localPath, processedData);

    // Save metadata to database
    const metadata: ImageMetadata = {
      hash,
      format,
      size: processedData.length,
      timestamp: Date.now(),
      uploaded: false,
      originalFilename,
    };

    this.db
      .prepare(
        `INSERT INTO images (hash, format, size, timestamp, uploaded, original_filename)
				 VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(hash, format, metadata.size, metadata.timestamp, 0, originalFilename || null);

    return {
      hash,
      placeholder: '',
      localPath,
      metadata,
    };
  }

  /**
   * Get image metadata by hash
   */
  getMetadata(hash: string): ImageMetadata | null {
    const row = this.db.prepare('SELECT * FROM images WHERE hash = ?').get(hash) as any;
    if (!row) return null;

    return {
      hash: row.hash,
      format: row.format,
      size: row.size,
      timestamp: row.timestamp,
      uploaded: Boolean(row.uploaded),
      s3Url: row.s3_url,
      originalFilename: row.original_filename,
    };
  }

  /**
   * Read image data from local cache
   */
  readImage(hash: string): Buffer | null {
    const metadata = this.getMetadata(hash);
    if (!metadata) return null;

    const localPath = join(ImageStore.IMAGES_DIR, `${hash}.${metadata.format.toLowerCase()}`);

    // Validate path stays within IMAGES_DIR to prevent path traversal
    const normalizedPath = resolve(localPath);
    if (!normalizedPath.startsWith(resolve(ImageStore.IMAGES_DIR))) {
      throw new Error('Invalid image path');
    }

    if (!existsSync(localPath)) return null;

    return readFileSync(localPath);
  }

  /**
   * Generate content hash for deduplication
   */
  private generateHash(data: Buffer): string {
    return createHash('sha256').update(data).digest('hex').substring(0, 16);
  }

  /**
   * Process image: compress if needed to stay under size limit
   */
  private async processImage(data: Buffer, originalFilename?: string): Promise<{ buffer: Buffer; format: string }> {
    // Check for very large images that could cause OOM
    if (data.length > ImageStore.MAX_PRECOMPRESS_SIZE) {
      throw new Error(
        `Image too large to process (${Math.round(data.length / 1024 / 1024)}MB). Maximum size is ${ImageStore.MAX_PRECOMPRESS_SIZE / 1024 / 1024}MB.`
      );
    }

    const originalFormat = this.detectFormat(data, originalFilename);

    // If already small enough, return as-is
    if (data.length <= ImageStore.MAX_RAW_SIZE) {
      return { buffer: data, format: originalFormat };
    }

    // Use sharp to resize/compress
    let image = sharp(data);

    // Get metadata
    const metadata = await image.metadata();
    if (!metadata.width || !metadata.height) {
      throw new Error('Unable to read image dimensions');
    }

    // Calculate new dimensions (maintain aspect ratio)
    const maxDimension = 2048;
    let width = metadata.width;
    let height = metadata.height;

    if (width > maxDimension || height > maxDimension) {
      if (width > height) {
        height = Math.round((height * maxDimension) / width);
        width = maxDimension;
      } else {
        width = Math.round((width * maxDimension) / height);
        height = maxDimension;
      }
    }

    // Resize
    image = image.resize(width, height);

    // Convert to JPEG with quality adjustment
    let quality = 85;
    let buffer = await image.jpeg({ quality }).toBuffer();

    // Reduce quality until we meet size limit
    while (buffer.length > ImageStore.MAX_RAW_SIZE && quality > 30) {
      quality -= 10;
      buffer = await image.jpeg({ quality }).toBuffer();
    }

    if (buffer.length > ImageStore.MAX_RAW_SIZE) {
      throw new Error(`Unable to compress image below ${ImageStore.MAX_RAW_SIZE / 1024}KB limit`);
    }

    return { buffer, format: 'jpg' };
  }

  /**
   * Detect image format from buffer or filename
   */
  private detectFormat(data: Buffer, filename?: string): string {
    // Check magic bytes
    if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
      return 'png';
    }
    if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
      return 'jpg';
    }
    if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) {
      return 'gif';
    }
    if (data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46) {
      return 'webp';
    }

    // Fallback to filename extension
    if (filename) {
      const ext = extname(filename).substring(1).toLowerCase();
      if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) {
        return ext === 'jpeg' ? 'jpg' : ext;
      }
    }

    return 'png'; // Default
  }

  /**
   * Clean up images older than retention period
   */
  private cleanupOldImages(): void {
    const cutoffTime = Date.now() - ImageStore.RETENTION_DAYS * 24 * 60 * 60 * 1000;

    const oldImages = this.db.prepare('SELECT hash, format FROM images WHERE timestamp < ?').all(cutoffTime) as Array<{
      hash: string;
      format: string;
    }>;

    for (const { hash, format } of oldImages) {
      const localPath = join(ImageStore.IMAGES_DIR, `${hash}.${format.toLowerCase()}`);
      if (existsSync(localPath)) {
        unlinkSync(localPath);
      }
    }

    this.db.prepare('DELETE FROM images WHERE timestamp < ?').run(cutoffTime);
  }

  /**
   * Close database connection
   */
  close(): void {
    this.db.close();
  }
}
