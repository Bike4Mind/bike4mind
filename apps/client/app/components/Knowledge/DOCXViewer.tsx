import React, { FC, useEffect, useState } from 'react';
import mammoth from 'mammoth';
import styles from '@/styles/content.module.css';
import { sanitizeHtmlStrict } from '@client/app/utils/htmlSanitizer';

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
        // mammoth emits HTML from an untrusted .docx into a plain app-origin DOM sink (no
        // sandbox iframe). Use the strict policy so injected <style>/<link>/document-shell
        // tags cannot smuggle app-origin CSS or external resource loads; inline style="..."
        // attributes (which mammoth uses for layout) survive.
        setHtmlContent(sanitizeHtmlStrict(result.value));
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
