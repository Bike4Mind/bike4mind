import React from 'react';

interface FileViewerIconProps {
  className?: string;
  style?: React.CSSProperties;
  width?: string | number;
  height?: string | number;
  fill?: string;
  stroke?: string;
  [key: string]: any; // For any additional props
}

const FileViewerIcon: React.FC<FileViewerIconProps> = ({
  className,
  style,
  width = 14,
  height = 10,
  fill = '#335F70',
  stroke,
  ...props
}) => {
  return (
    <svg
      {...props}
      className={className}
      style={style}
      width={width}
      height={height}
      viewBox="0 0 14 10"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M12.6 1.25146H7L5.6 0.00146484H1.4C0.63 0.00146484 0.00699999 0.563965 0.00699999 1.25146L0 8.75146C0 9.43896 0.63 10.0015 1.4 10.0015H12.6C13.37 10.0015 14 9.43896 14 8.75146V2.50146C14 1.81396 13.37 1.25146 12.6 1.25146ZM9.1 3.12646C9.87 3.12646 10.5 3.68896 10.5 4.37646C10.5 5.06396 9.87 5.62646 9.1 5.62646C8.33 5.62646 7.7 5.06396 7.7 4.37646C7.7 3.68896 8.33 3.12646 9.1 3.12646ZM11.9 8.12646H6.3V7.50146C6.3 6.67021 8.169 6.25146 9.1 6.25146C10.031 6.25146 11.9 6.67021 11.9 7.50146V8.12646Z"
        fill={fill}
      />
    </svg>
  );
};

export default FileViewerIcon;
