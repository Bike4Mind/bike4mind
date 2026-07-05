import { readFileSync, existsSync, statSync } from 'fs';
import { extname } from 'path';

export interface ImagePasteEvent {
  type: 'paste';
  data: Buffer;
  format: string;
  protocol: 'iterm2' | 'kitty' | 'sixel' | 'base64';
}

export interface FileDropEvent {
  type: 'drop';
  data: Buffer;
  format: string;
  filename: string;
  filepath: string;
}

export type ImageInputEvent = ImagePasteEvent | FileDropEvent;

/**
 * Detects pasted images and dropped files from terminal input
 * Supports iTerm2, Kitty, and Sixel protocols
 */
export class ImageInputDetector {
  private static readonly MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB
  private static readonly SUPPORTED_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];

  /**
   * Check if input contains image data
   */
  static containsImageData(input: string): boolean {
    // Check for iTerm2 inline image protocol
    if (input.includes('\x1b]1337;File=')) {
      return true;
    }

    // Check for Kitty graphics protocol
    if (input.includes('\x1b_G')) {
      return true;
    }

    // Check for Sixel protocol
    if (input.includes('\x1bP')) {
      return true;
    }

    // Check for base64 data URL
    if (input.match(/data:image\/(png|jpeg|jpg|gif|webp);base64,/)) {
      return true;
    }

    // Check for file path (potential drag-and-drop)
    if (this.looksLikeFilePath(input)) {
      return true;
    }

    return false;
  }

  /**
   * Extract image data from terminal input
   */
  static extractImageData(input: string): ImageInputEvent | null {
    // Try iTerm2 protocol first
    const iterm2 = this.extractITerm2Image(input);
    if (iterm2) return iterm2;

    // Try Kitty protocol
    const kitty = this.extractKittyImage(input);
    if (kitty) return kitty;

    // Try Sixel protocol
    const sixel = this.extractSixelImage(input);
    if (sixel) return sixel;

    // Try base64 data URL
    const base64 = this.extractBase64Image(input);
    if (base64) return base64;

    // Try file path (drag-and-drop)
    const fileDrop = this.extractDroppedFile(input);
    if (fileDrop) return fileDrop;

    return null;
  }

  /**
   * Extract iTerm2 inline image
   * Format: ESC]1337;File=[args]:base64data^G
   */
  private static extractITerm2Image(input: string): ImagePasteEvent | null {
    // eslint-disable-next-line no-control-regex -- intentional: matching iTerm2 ESC sequences
    const match = input.match(/\x1b\]1337;File=([^:]*):([^\x07]+)\x07/);
    if (!match) return null;

    try {
      const args = match[1];
      const base64Data = match[2];
      const data = Buffer.from(base64Data, 'base64');

      // Parse args for format hint
      let format = 'png';
      const nameMatch = args.match(/name=([^;]+)/);
      if (nameMatch) {
        const ext = extname(nameMatch[1]).substring(1).toLowerCase();
        if (ext && this.SUPPORTED_EXTENSIONS.includes(`.${ext}`)) {
          format = ext === 'jpeg' ? 'jpg' : ext;
        }
      }

      return {
        type: 'paste',
        data,
        format,
        protocol: 'iterm2',
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * Extract Kitty graphics protocol image
   * Format: ESC_Ga=T,f=100;base64data ESC\
   */
  private static extractKittyImage(input: string): ImagePasteEvent | null {
    // eslint-disable-next-line no-control-regex -- intentional: matching Kitty graphics ESC sequences
    const match = input.match(/\x1b_G([^;]*);([^\x1b]+)\x1b\\/);
    if (!match) return null;

    try {
      const params = match[1];
      const base64Data = match[2];
      const data = Buffer.from(base64Data, 'base64');

      // Parse format from params (f=24 for PNG, f=32 for RGB, etc.)
      let format = 'png';
      const formatMatch = params.match(/f=(\d+)/);
      if (formatMatch) {
        const formatCode = parseInt(formatMatch[1], 10);
        // Kitty format codes: 24=PNG, 32=RGB, 100=JPEG
        if (formatCode === 100) format = 'jpg';
      }

      return {
        type: 'paste',
        data,
        format,
        protocol: 'kitty',
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * Extract Sixel image
   * Format: ESC P q ... ESC \
   */
  private static extractSixelImage(input: string): ImagePasteEvent | null {
    // eslint-disable-next-line no-control-regex -- intentional: matching Sixel ESC sequences
    const match = input.match(/\x1bP([^q]*q[^\x1b]+)\x1b\\/);
    if (!match) return null;

    // Sixel decoding needs a dedicated decoder library; not implemented (uncommon), so return null
    return null;
  }

  /**
   * Extract base64 data URL
   * Format: data:image/png;base64,iVBORw0KGgo...
   */
  private static extractBase64Image(input: string): ImagePasteEvent | null {
    const match = input.match(/data:image\/(png|jpeg|jpg|gif|webp);base64,([A-Za-z0-9+/=]+)/);
    if (!match) return null;

    try {
      const format = match[1] === 'jpeg' ? 'jpg' : match[1];
      const base64Data = match[2];
      const data = Buffer.from(base64Data, 'base64');

      return {
        type: 'paste',
        data,
        format,
        protocol: 'base64',
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * Extract dropped file path and read image
   */
  private static extractDroppedFile(input: string): FileDropEvent | null {
    if (!this.looksLikeFilePath(input)) return null;

    // Clean up the path (remove quotes, escape characters, etc.)
    let filepath = input.trim();
    filepath = filepath.replace(/^["']|["']$/g, ''); // Remove surrounding quotes
    // Remove ALL escape backslashes (Finder escapes spaces, parens, brackets, etc.)
    filepath = filepath.replace(/\\(.)/g, '$1'); // Replace \x with x for any character

    // Check if file exists
    if (!existsSync(filepath)) return null;

    // Check if it's a file (not directory)
    const stats = statSync(filepath);
    if (!stats.isFile()) return null;

    // Check extension
    const ext = extname(filepath).toLowerCase();
    if (!this.SUPPORTED_EXTENSIONS.includes(ext)) return null;

    // Check file size
    if (stats.size > this.MAX_IMAGE_SIZE) return null;

    try {
      const data = readFileSync(filepath);
      const format = ext.substring(1) === 'jpeg' ? 'jpg' : ext.substring(1);
      const filename = filepath.split('/').pop() || 'image';

      return {
        type: 'drop',
        data,
        format,
        filename,
        filepath,
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * Check if string looks like a file path
   */
  private static looksLikeFilePath(input: string): boolean {
    const trimmed = input.trim();

    // Check for absolute paths (but exclude slash commands)
    if (trimmed.startsWith('/')) {
      // Exclude slash commands (single word after /, no additional slashes)
      // Examples: /help, /config, /rewind (these are commands)
      // Examples: /Users/foo/bar.png, /tmp/image.jpg (these are paths)
      const hasMultipleSegments = trimmed.indexOf('/', 1) !== -1;
      const hasImageExtension = this.SUPPORTED_EXTENSIONS.some(ext => trimmed.toLowerCase().endsWith(ext));

      // Only treat as file path if it has multiple path segments OR has image extension
      if (hasMultipleSegments || hasImageExtension) {
        return true;
      }

      // Single slash followed by word (like /help) -> not a file path
      return false;
    }

    // Windows absolute paths
    if (trimmed.match(/^[a-zA-Z]:\\/)) {
      return true;
    }

    // Check for home directory paths
    if (trimmed.startsWith('~')) {
      return true;
    }

    // Check for relative paths with supported extensions
    if (this.SUPPORTED_EXTENSIONS.some(ext => trimmed.toLowerCase().endsWith(ext))) {
      return true;
    }

    return false;
  }

  /**
   * Remove image data from input string, leaving only text
   */
  static stripImageData(input: string): string {
    let cleaned = input;

    // Remove iTerm2 sequences
    // eslint-disable-next-line no-control-regex -- intentional: stripping terminal ESC sequences
    cleaned = cleaned.replace(/\x1b\]1337;File=[^:]*:[^\x07]+\x07/g, '');

    // Remove Kitty sequences
    // eslint-disable-next-line no-control-regex -- intentional: stripping terminal ESC sequences
    cleaned = cleaned.replace(/\x1b_G[^;]*;[^\x1b]+\x1b\\/g, '');

    // Remove Sixel sequences
    // eslint-disable-next-line no-control-regex -- intentional: stripping terminal ESC sequences
    cleaned = cleaned.replace(/\x1bP[^q]*q[^\x1b]+\x1b\\/g, '');

    // Remove base64 data URLs
    cleaned = cleaned.replace(/data:image\/(png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/=]+/g, '');

    // Remove file paths (if they look like image files)
    const filepath = this.extractDroppedFile(cleaned);
    if (filepath) {
      cleaned = cleaned.replace(filepath.filepath, '');
    }

    return cleaned.trim();
  }
}
