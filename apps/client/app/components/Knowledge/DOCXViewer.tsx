import React, { FC, useEffect, useState } from 'react';
import mammoth from 'mammoth';
import styles from '@/styles/content.module.css';

type DocxViewerProps = {
  fileUrl: string;
};

const DocxViewer: FC<DocxViewerProps> = ({ fileUrl }) => {
  const [htmlContent, setHtmlContent] = useState<string>('');

  useEffect(() => {
    fetch(fileUrl)
      .then(response => response.arrayBuffer())
      .then(arrayBuffer => {
        return mammoth.convertToHtml({ arrayBuffer });
      })
      .then(result => {
        const { value } = result;
        setHtmlContent(value);
      })
      .catch(error => {
        console.error('Error fetching and converting DOCX to HTML', error);
      });
  }, [fileUrl]);

  return (
    <div className={`docx-viewer-container ${styles.docxContainer}`}>
      <div className="docx-viewer-content" dangerouslySetInnerHTML={{ __html: htmlContent }} />
    </div>
  );
};

export default DocxViewer;
