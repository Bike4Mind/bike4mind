import React, { useEffect, useId, useMemo, useRef } from 'react';
import DOMPurify from 'dompurify';
import { gray } from '../../utils/themes/colors';

interface FillableSvgProps {
  svgContent: string;
  fillPercentage: number;
  fillColor: string;
  width?: number;
  height?: number;
}

const FillableSvg: React.FC<FillableSvgProps> = ({
  svgContent,
  fillPercentage,
  fillColor,
  width = 100,
  height = 100,
}) => {
  const baseContainerRef = useRef<HTMLDivElement>(null);
  const fillContainerRef = useRef<HTMLDivElement>(null);
  const reactId = useId();
  const clipPathId = useMemo(() => `fill-clip-${reactId}`, [reactId]);
  const clipRectId = useMemo(() => `clip-rect-${reactId}`, [reactId]);

  useEffect(() => {
    const fillByPercentage = (percentage: number) => {
      const clipRect = document.getElementById(clipRectId);
      if (!clipRect) return;

      const svgElement = fillContainerRef.current?.querySelector('.fillable-svg');
      if (!svgElement) return;

      const viewBox = svgElement.getAttribute('viewBox');
      if (!viewBox) return;

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const [minX, minY, viewBoxWidth, viewBoxHeight] = viewBox.split(' ').map(Number);

      const height = viewBoxHeight * (percentage / 100);
      const y = minY + (viewBoxHeight - height);

      clipRect.setAttribute('height', `${height}`);
      clipRect.setAttribute('y', `${y}`);
    };

    fillByPercentage(fillPercentage);
  }, [fillPercentage, svgContent]);

  const baseSvgContent = svgContent.replace(/fill="[^"]*"/g, `fill="${gray[185]}"`);
  const fillSvgContent = svgContent
    .replace(/fill="[^"]*"/g, `fill="${fillColor}"`)
    .replace(
      /<svg([^>]*)>/,
      `<svg$1 class="fillable-svg" style="position: absolute; top: 0; left: 0;"><defs><clipPath id="${clipPathId}"><rect id="${clipRectId}" x="0" y="0" width="100%" height="0"></rect></clipPath></defs>`
    )
    .replace(/<path/g, `<path clip-path="url(#${clipPathId})"`);

  // Sanitize SVG content
  const sanitizedBaseSvgContent = DOMPurify.sanitize(baseSvgContent, {
    USE_PROFILES: { svg: true, svgFilters: true },
    ADD_TAGS: ['foreignObject'],
    ADD_ATTR: ['xmlns', 'xmlns:xlink', 'viewBox', 'preserveAspectRatio', 'class', 'style', 'clip-path'],
  });

  const sanitizedFillSvgContent = DOMPurify.sanitize(fillSvgContent, {
    USE_PROFILES: { svg: true, svgFilters: true },
    ADD_TAGS: ['foreignObject'],
    ADD_ATTR: ['xmlns', 'xmlns:xlink', 'viewBox', 'preserveAspectRatio', 'class', 'style', 'clip-path'],
  });

  return (
    <div style={{ position: 'relative', width, height, margin: 'auto' }}>
      <div ref={baseContainerRef} dangerouslySetInnerHTML={{ __html: sanitizedBaseSvgContent }} />
      <div ref={fillContainerRef} dangerouslySetInnerHTML={{ __html: sanitizedFillSvgContent }} />
    </div>
  );
};

export default FillableSvg;
