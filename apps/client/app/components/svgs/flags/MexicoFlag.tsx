import { FC, SVGAttributes } from 'react';

const MexicoFlag: FC<SVGAttributes<SVGSVGElement>> = props => {
  return (
    <svg {...props} viewBox="0 0 22 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <g clipPath="url(#clip0_2_841)">
        <g clipPath="url(#clip1_2_841)">
          <rect width="22" height="16" rx="2" fill="white" />
          <rect x="16" width="6" height="16" fill="#F93939" />
          <rect width="6" height="16" fill="#249F58" />
          <path
            fillRule="evenodd"
            clipRule="evenodd"
            d="M13.9766 8.00053C13.9919 8.10956 13.9999 8.22095 13.9999 8.33354C13.9999 9.80598 12.6566 10.9999 10.9999 10.9999C9.34327 10.9999 7.99994 9.80598 7.99994 8.33354C7.99994 8.22095 8.00794 8.10956 8.02327 7.99994C8.20794 9.02384 9.46994 9.81487 10.9999 9.81487C12.5299 9.81487 13.7919 9.02325 13.9766 7.99994V8.00053Z"
            fill="#249F58"
          />
          <ellipse cx="11" cy="6.93331" rx="1.57143" ry="1.6" fill="#AE6A3E" />
        </g>
      </g>
      <defs>
        <clipPath id="clip0_2_841">
          <rect width="22" height="16" fill="white" />
        </clipPath>
        <clipPath id="clip1_2_841">
          <rect width="22" height="16" rx="2" fill="white" />
        </clipPath>
      </defs>
    </svg>
  );
};
export default MexicoFlag;
