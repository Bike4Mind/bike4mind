import { useState, useCallback, useMemo } from 'react';
import { IFabFileDocument } from '@bike4mind/common';
import { api } from '../contexts/ApiContext';
import { toast } from 'sonner';

/**
 * Image browser hook
 * Single responsibility: browsing and selecting images
 */
export const useImageBrowser = () => {
  const [isImageBrowserOpen, setIsImageBrowserOpen] = useState(false);
  const [imageFiles, setImageFiles] = useState<IFabFileDocument[]>([]);
  const [isLoadingImages, setIsLoadingImages] = useState(false);
  const [selectedImage, setSelectedImage] = useState<IFabFileDocument | null>(null);
  const [imageSearch, setImageSearch] = useState('');

  const fetchImageFiles = useCallback(async (searchTerm: string = '') => {
    setIsLoadingImages(true);
    try {
      const response = await api.get<{ data: IFabFileDocument[] }>('/api/files', {
        params: {
          search: searchTerm,
          filters: { type: 'image' },
          pagination: { page: 1, limit: 50 },
          extensions: '.jpg,.jpeg,.png,.gif,.webp,.svg,.bmp,.tiff',
        },
      });

      const validImageFiles = response.data.data.filter(file => {
        return file.mimeType?.startsWith('image/') && !!file.fileUrl;
      });

      setImageFiles(validImageFiles);
    } catch (error) {
      console.error('Error fetching image files:', error);
      toast.error('Failed to load images');
    } finally {
      setIsLoadingImages(false);
    }
  }, []);

  const openImageBrowser = useCallback(() => {
    setIsImageBrowserOpen(true);
    fetchImageFiles(imageSearch);
  }, [fetchImageFiles, imageSearch]);

  const closeImageBrowser = useCallback(() => {
    setIsImageBrowserOpen(false);
    setSelectedImage(null);
  }, []);

  const selectImage = useCallback((file: IFabFileDocument) => {
    setSelectedImage(file);
  }, []);

  const applySelectedImage = useCallback((file: IFabFileDocument, onApply: (imageUrl: string) => void) => {
    if (file.fileUrl) {
      onApply(file.fileUrl);
      setIsImageBrowserOpen(false);
      setSelectedImage(null);
    }
  }, []);

  const filteredImages = useMemo(() => {
    if (!imageSearch) return imageFiles;
    return imageFiles.filter(file => file.fileName.toLowerCase().includes(imageSearch.toLowerCase()));
  }, [imageFiles, imageSearch]);

  return {
    isImageBrowserOpen,
    imageFiles: filteredImages,
    isLoadingImages,
    selectedImage,
    imageSearch,
    setImageSearch,
    openImageBrowser,
    closeImageBrowser,
    selectImage,
    applySelectedImage,
    fetchImageFiles,
  };
};
