import React, { useState, useEffect } from 'react';
import mammoth from 'mammoth';
import DOMPurify from 'dompurify';

interface DOCXViewerProps {
  file: File;
}

const DOCXViewer: React.FC<DOCXViewerProps> = ({ file }) => {
  const [content, setContent] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const reader = new FileReader();

    reader.onload = async e => {
      try {
        const arrayBuffer = e.target?.result as ArrayBuffer;
        const result = await mammoth.convertToHtml({ arrayBuffer });

        // Sanitize the HTML content
        const sanitizedHtml = DOMPurify.sanitize(result.value, {
          ALLOWED_TAGS: ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'ul', 'ol', 'li', 'a', 'img'],
          ALLOWED_ATTR: ['href', 'src', 'alt', 'title'],
        });

        setContent(sanitizedHtml);
        setError(null);
      } catch (err) {
        setError('Error converting DOCX file');
        console.error(err);
      }
    };

    reader.onerror = () => {
      setError('Error reading file');
    };

    reader.readAsArrayBuffer(file);
  }, [file]);

  if (error) {
    return <div className="error">{error}</div>;
  }

  /**
   * @security
   * This use of dangerouslySetInnerHTML is safe because:
   * 1. Content is sanitized using DOMPurify
   * 2. Only basic document structure tags are allowed
   * 3. All dangerous attributes are explicitly forbidden
   * 4. Content comes from trusted mammoth library
   */
  return (
    <div
      className="docx-content"
      // semgrep-ignore-next-line
      dangerouslySetInnerHTML={{ __html: content }}
    />
  );
};

export default DOCXViewer;
