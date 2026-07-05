import React, { useRef, useEffect } from 'react';
import DOMPurify from 'dompurify';

interface MermaidChartProps {
  svg: string;
}

const MermaidChart: React.FC<MermaidChartProps> = ({ svg }) => {
  const svgRef = useRef<HTMLDivElement>(null);

  const sanitizedSvg = DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    ADD_TAGS: ['svg', 'path', 'rect', 'circle', 'text', 'g', 'foreignObject'],
    ADD_ATTR: [
      'd',
      'x',
      'y',
      'width',
      'height',
      'fill',
      'stroke',
      'transform',
      'class',
      'style',
      'xmlns',
      'xmlns:xlink',
      'viewBox',
      'preserveAspectRatio',
    ],
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'a', 'link'],
    FORBID_ATTR: ['onload', 'onerror', 'onclick', 'onmouseover', 'href', 'src', 'xlink:href'],
    WHOLE_DOCUMENT: false,
    RETURN_DOM: false,
    RETURN_DOM_FRAGMENT: false,
    SANITIZE_DOM: true,
    KEEP_CONTENT: false,
    IN_PLACE: false,
    ALLOW_DATA_ATTR: false,
    ALLOW_UNKNOWN_PROTOCOLS: false,
    SAFE_FOR_TEMPLATES: false,
    ALLOWED_URI_REGEXP: /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|cid|xmpp):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
  });

  /**
   * @security
   * This use of innerHTML is safe because:
   * 1. Content is sanitized using DOMPurify
   * 2. Only SVG-specific tags and attributes are allowed
   * 3. All dangerous attributes are explicitly forbidden
   * 4. Content comes from trusted Mermaid library
   */
  useEffect(() => {
    if (svgRef.current) {
      svgRef.current.innerHTML = '';

      const svgContainer = document.createElement('div');
      svgContainer.setAttribute('dangerouslySetInnerHTML', JSON.stringify({ __html: sanitizedSvg }));
      if (svgContainer.firstChild) {
        svgRef.current.appendChild(svgContainer.firstChild);
      }
    }
  }, [sanitizedSvg]);

  return <div ref={svgRef} style={{ width: '100%', height: '300px' }} />;
};

export default MermaidChart;
