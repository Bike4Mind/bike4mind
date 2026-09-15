export interface ImagePlaceholder {
  hash: string;
  number: number;
  placeholder: string; // e.g., "[Image 1]"
}

/**
 * Manages image placeholder rendering in conversation
 * Tracks image numbering per session
 */
export class ImageRenderer {
  private imageCounter: number = 0;
  private placeholderMap: Map<string, ImagePlaceholder> = new Map();

  /**
   * Generate placeholder for a new image
   */
  createPlaceholder(hash: string): string {
    // Check if we already have a placeholder for this hash
    const existing = this.placeholderMap.get(hash);
    if (existing) {
      return existing.placeholder;
    }

    // Create new placeholder
    this.imageCounter++;
    const placeholder = `[Image ${this.imageCounter}]`;

    this.placeholderMap.set(hash, {
      hash,
      number: this.imageCounter,
      placeholder,
    });

    return placeholder;
  }

  /**
   * Get all image hashes from a message containing placeholders
   */
  extractImageHashes(message: string): string[] {
    const hashes: string[] = [];

    // Find all placeholders like [Image 1], [Image 2], etc.
    const placeholderRegex = /\[Image \d+\]/g;
    const matches = message.match(placeholderRegex);

    if (!matches) return hashes;

    // Look up hash for each placeholder
    for (const [hash, data] of this.placeholderMap.entries()) {
      if (matches.includes(data.placeholder)) {
        hashes.push(hash);
      }
    }

    return hashes;
  }

  /**
   * Get hash by placeholder text
   */
  getHashFromPlaceholder(placeholder: string): string | null {
    for (const [hash, data] of this.placeholderMap.entries()) {
      if (data.placeholder === placeholder) {
        return hash;
      }
    }
    return null;
  }
}
