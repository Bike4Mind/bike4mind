import { FC, SVGAttributes } from 'react';

const BrazilFlag: FC<SVGAttributes<SVGSVGElement>> = props => {
  return (
    <svg {...props} viewBox="0 0 22 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <g clipPath="url(#clip0_2_1333)">
        <rect width="22" height="16" rx="2" fill="#249F58" />
        <path fillRule="evenodd" clipRule="evenodd" d="M11 2.13333L18.8572 8L11 13.8667L3.14288 8" fill="#FFDA2C" />
        <path
          d="M11 11.7333C13.025 11.7333 14.6666 10.0619 14.6666 8C14.6666 5.93813 13.025 4.26666 11 4.26666C8.97494 4.26666 7.33331 5.93813 7.33331 8C7.33331 10.0619 8.97494 11.7333 11 11.7333Z"
          fill="#1A47B8"
        />
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M9.42859 9.60001V10.6667H10.4762V9.60001H9.42859ZM11.5238 9.60001V10.6667H12.5714V9.60001H11.5238Z"
          fill="white"
        />
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M8.38098 6.39999C8.38098 6.39999 10.7528 6.82666 12.4625 7.57119L14.6667 8.53333"
          fill="white"
        />
        <path d="M8.38098 6.39999C8.38098 6.39999 10.7528 6.82666 12.4625 7.57119L14.6667 8.53333" stroke="white" />
      </g>
      <defs>
        <clipPath id="clip0_2_1333">
          <rect width="22" height="16" fill="white" />
        </clipPath>
      </defs>
    </svg>
  );
};
export default BrazilFlag;
