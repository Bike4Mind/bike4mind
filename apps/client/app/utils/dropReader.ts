/**
 * Shared drag-and-drop file readers for folder-aware uploads. Traverses
 * DataTransferItem entries recursively and stamps webkitRelativePath on each File
 * so downstream folder-tree parsing (parseFilesToTree) preserves structure.
 *
 * Extracted from the data lake wizard's SourceSelectionStep so the /opti Data Lake
 * Explorer (and any future drop target) reuses the exact same traversal.
 */

/**
 * Recursively reads all files from a FileSystemDirectoryEntry.
 * Returns File objects with webkitRelativePath set manually.
 */
async function readDirectoryEntries(dirEntry: FileSystemDirectoryEntry, basePath: string): Promise<File[]> {
  const reader = dirEntry.createReader();
  const allFiles: File[] = [];

  // readEntries returns batches of up to 100 entries; must loop until empty
  const readBatch = (): Promise<FileSystemEntry[]> =>
    new Promise((resolve, reject) => reader.readEntries(resolve, reject));

  let batch: FileSystemEntry[];
  do {
    batch = await readBatch();
    for (const entry of batch) {
      const entryPath = basePath ? `${basePath}/${entry.name}` : entry.name;
      if (entry.isFile) {
        const fileEntry = entry as FileSystemFileEntry;
        const file = await new Promise<File>((resolve, reject) => fileEntry.file(resolve, reject));
        // Create a new File with webkitRelativePath set so parseFilesToTree works
        const fileWithPath = new File([file], file.name, { type: file.type, lastModified: file.lastModified });
        Object.defineProperty(fileWithPath, 'webkitRelativePath', { value: entryPath, writable: false });
        allFiles.push(fileWithPath);
      } else if (entry.isDirectory) {
        const subFiles = await readDirectoryEntries(entry as FileSystemDirectoryEntry, entryPath);
        allFiles.push(...subFiles);
      }
    }
  } while (batch.length > 0);

  return allFiles;
}

/**
 * Reads all files from a DataTransferItemList, traversing directories recursively.
 */
export async function readDroppedItems(items: DataTransferItemList): Promise<File[]> {
  const allFiles: File[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const entry = item.webkitGetAsEntry?.();
    if (!entry) {
      // Fallback: plain file
      const file = item.getAsFile();
      if (file) allFiles.push(file);
      continue;
    }

    if (entry.isDirectory) {
      const dirFiles = await readDirectoryEntries(entry as FileSystemDirectoryEntry, entry.name);
      allFiles.push(...dirFiles);
    } else if (entry.isFile) {
      const fileEntry = entry as FileSystemFileEntry;
      const file = await new Promise<File>((resolve, reject) => fileEntry.file(resolve, reject));
      Object.defineProperty(file, 'webkitRelativePath', { value: entry.name, writable: false });
      allFiles.push(file);
    }
  }

  return allFiles;
}
