import React, { useRef, useState } from 'react';

import { FilePond, registerPlugin } from 'react-filepond';

import FilePondPluginFileValidateSize from 'filepond-plugin-file-validate-size';
import 'filepond/dist/filepond.min.css';

import FilePondPluginImageExifOrientation from 'filepond-plugin-image-exif-orientation';
import FilePondPluginImagePreview from 'filepond-plugin-image-preview';
import 'filepond-plugin-image-preview/dist/filepond-plugin-image-preview.css';
import { IFabFileDocument, IShareableDocument, KnowledgeType } from '@bike4mind/common';
import { useServerSettings } from '@client/app/contexts/UserSettingsContext';
import { toast } from 'sonner';
import { createFabFileOnServerWithUpload } from '@client/app/utils/filesAPICalls';

registerPlugin(FilePondPluginImageExifOrientation, FilePondPluginImagePreview);
registerPlugin(FilePondPluginFileValidateSize);

interface FilePondModalProps {
  onFileProcessComplete: (fabfile: IFabFileDocument | IShareableDocument) => void;
}

const FilePondModal: React.FC<FilePondModalProps> = ({ onFileProcessComplete }) => {
  const [files] = useState<any[]>([]);
  const pond = useRef(null);
  const { serverSettings } = useServerSettings();
  const maxFileSize = serverSettings.find(setting => setting.settingName === 'MaxFileSize') || 100;
  // FilePond expects the max file size as a string in MB, e.g. '100MB'
  const maxFileSizeForFilePond = `${maxFileSize}MB`;

  const handleInit = () => {
    console.log('FilePond instance has initialised', pond);
  };

  return (
    <FilePond
      ref={pond}
      files={files}
      maxFileSize={maxFileSizeForFilePond}
      allowMultiple={true}
      credits={false}
      maxFiles={20}
      acceptedFileTypes={[
        // Web development
        'text/typescript',
        '.ts',
        '.tsx',
        '.js',
        '.jsx',
        '.html',
        '.css',
        '.scss',
        '.less',
        // Backend development
        '.py',
        '.java',
        '.rb',
        '.php',
        '.go',
        '.rs',
        '.cs',
        '.cpp',
        '.c',
        '.h',
        // Configuration and data
        '.json',
        '.yaml',
        '.yml',
        '.toml',
        '.ini',
        '.env',
        // Shell and scripts
        '.sh',
        '.bash',
        '.zsh',
        '.ps1',
        // Other common formats
        '.sql',
        '.graphql',
        '.md',
        '.txt',
        '.csv',
        // Generic text
        'text/plain',
        'text/*',
        '.xlsx',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ]}
      server={{
        process: (fieldName, file, metadata, load, error, progress, abort) => {
          const reader = new FileReader();
          reader.onload = async () => {
            const data = {
              type: KnowledgeType.FILE,
              fileName: file.name,
              mimeType: file.type,
              fileSize: file.size,
            };

            createFabFileOnServerWithUpload(data, file)
              .then(async fabFile => {
                onFileProcessComplete(fabFile);
                load(fabFile.id);
                toast.success('File uploaded successfully');
              })
              .catch(e => {
                console.error(e);
                error('Failed to upload file');
              });
          };
          reader.readAsArrayBuffer(file);
        },
      }}
      name="content"
      oninit={handleInit}
    />
  );
};

export default FilePondModal;
