import { FC, SVGAttributes } from 'react';

const FranceFlag: FC<SVGAttributes<SVGSVGElement>> = props => {
  return (
    <svg {...props} viewBox="0 0 22 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <g clipPath="url(#clip0_2_1111)">
        <g clipPath="url(#clip1_2_1111)">
          <rect width="22" height="16" rx="2" fill="white" />
          <path fillRule="evenodd" clipRule="evenodd" d="M0 0H7V16H0V0Z" fill="#1A47B8" />
          <path fillRule="evenodd" clipRule="evenodd" d="M15 0H22V16H15V0Z" fill="#F93939" />
        </g>
      </g>
      <defs>
        <clipPath id="clip0_2_1111">
          <rect width="22" height="16" fill="white" />
        </clipPath>
        <clipPath id="clip1_2_1111">
          <rect width="22" height="16" rx="2" fill="white" />
        </clipPath>
      </defs>
    </svg>
  );
};
export default FranceFlag;
