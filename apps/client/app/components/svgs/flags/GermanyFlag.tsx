import { FC, SVGAttributes } from 'react';

const GermanyFlag: FC<SVGAttributes<SVGSVGElement>> = props => {
  return (
    <svg {...props} viewBox="0 0 22 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <g clipPath="url(#clip0_2_1093)">
        <g clipPath="url(#clip1_2_1093)">
          <rect width="22" height="16" rx="2" fill="#F93939" />
          <path fillRule="evenodd" clipRule="evenodd" d="M0 11H23V16H0V11Z" fill="#FFDA2C" />
          <path fillRule="evenodd" clipRule="evenodd" d="M0 0H23V5H0V0Z" fill="#151515" />
        </g>
      </g>
      <defs>
        <clipPath id="clip0_2_1093">
          <rect width="22" height="16" fill="white" />
        </clipPath>
        <clipPath id="clip1_2_1093">
          <rect width="22" height="16" rx="2" fill="white" />
        </clipPath>
      </defs>
    </svg>
  );
};
export default GermanyFlag;
