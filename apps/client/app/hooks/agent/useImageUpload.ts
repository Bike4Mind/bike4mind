import { useState, useRef, useCallback } from 'react';
import { KnowledgeType } from '@bike4mind/common';
import { createFabFileOnServerWithUpload } from '../../utils/filesAPICalls';
import { api } from '../../contexts/ApiContext';
import { toast } from 'sonner';

/**
 * Image upload hook
 */
export const useImageUpload = (onImageUploaded: (imageUrl: string) => void) => {
  const [isDraggingImage, setIsDraggingImage] = useState(false);
  const [isUploadingImage, setIsUploadingImage] = useState(false);
  const dragCounter = useRef(0);

  const handleDragEnter = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current++;

    if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
      setIsDraggingImage(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current--;

    if (dragCounter.current === 0) {
      setIsDraggingImage(false);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const uploadImage = useCallback(
    async (file: File) => {
      setIsUploadingImage(true);
      try {
        const data = {
          type: KnowledgeType.FILE,
          fileName: file.name,
          mimeType: file.type,
          fileSize: file.size,
        };

        const uploadedFile = await createFabFileOnServerWithUpload(data, file);

        if (!uploadedFile?.id) {
          throw new Error('Failed to upload image file');
        }

        // Wait for URL generation
        await new Promise(resolve => setTimeout(resolve, 1500));

        try {
          const response = await api.get(`/api/files/${uploadedFile.id}`);
          const refreshedFile = response.data;

          if (refreshedFile?.fileUrl) {
            onImageUploaded(refreshedFile.fileUrl);
            toast.success(`Image uploaded and set as agent portrait: ${file.name}`);
          } else if (uploadedFile.fileUrl) {
            onImageUploaded(uploadedFile.fileUrl);
            toast.success(`Image uploaded and set as agent portrait: ${file.name}`);
          } else {
            throw new Error('Could not get a valid URL for the uploaded image');
          }
        } catch (fetchError) {
          console.error('Error fetching updated file data:', fetchError);
          if (uploadedFile.fileUrl) {
            onImageUploaded(uploadedFile.fileUrl);
            toast.success(`Image uploaded and set as agent portrait: ${file.name}`);
          } else {
            throw new Error('Could not get a valid URL for the uploaded image');
          }
        }
      } catch (error) {
        console.error('Error uploading agent portrait:', error);
        toast.error('Failed to upload portrait image. Please try again.');
      } finally {
        setIsUploadingImage(false);
      }
    },
    [onImageUploaded]
  );

  const handleImageDrop = useCallback(
    async (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDraggingImage(false);
      dragCounter.current = 0;

      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        const file = e.dataTransfer.files[0];
        if (!file.type.startsWith('image/')) {
          toast.error('Only image files can be used as agent portraits');
          return;
        }
        await uploadImage(file);
        e.dataTransfer.clearData();
      }
    },
    [uploadImage]
  );

  return {
    isDraggingImage,
    isUploadingImage,
    handleDragEnter,
    handleDragLeave,
    handleDragOver,
    handleImageDrop,
    uploadImage,
  };
};
