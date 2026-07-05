import { FC, SVGAttributes } from 'react';

const UnitedKingdomFlag: FC<SVGAttributes<SVGSVGElement>> = props => {
  return (
    <svg {...props} viewBox="0 0 22 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <g clipPath="url(#clip0_2_418)">
        <g clipPath="url(#clip1_2_418)">
          <rect width="22" height="16" rx="2" fill="#1A47B8" />
          <path
            fillRule="evenodd"
            clipRule="evenodd"
            d="M2.34035 0H0V2.66667L19.6469 16L22 16V13.3333L2.34035 0Z"
            fill="white"
          />
          <path d="M0.780579 0L22 14.4378V16H21.2377L0 1.54726V0H0.780579Z" fill="#F93939" />
          <path
            fillRule="evenodd"
            clipRule="evenodd"
            d="M19.9048 0H22.0001V2.66667C22.0001 2.66667 8.39128 11.5499 2.0953 16H6.10352e-05V13.3333L19.9048 0Z"
            fill="white"
          />
          <path d="M22 0H21.2895L0 14.4502V16H0.780579L22 1.55895V0Z" fill="#F93939" />
          <path
            fillRule="evenodd"
            clipRule="evenodd"
            d="M8.00075 0H14.0176V4.93527H22V11.0615H14.0176V16H8.00075V11.0615H0V4.93527H8.00075V0Z"
            fill="white"
          />
          <path
            fillRule="evenodd"
            clipRule="evenodd"
            d="M9.26316 0H12.7368V6.15385H22V9.84615H12.7368V16H9.26316V9.84615H0V6.15385H9.26316V0Z"
            fill="#F93939"
          />
        </g>
      </g>
      <defs>
        <clipPath id="clip0_2_418">
          <rect width="22" height="16" fill="white" />
        </clipPath>
        <clipPath id="clip1_2_418">
          <rect width="22" height="16" rx="2" fill="white" />
        </clipPath>
      </defs>
    </svg>
  );
};
export default UnitedKingdomFlag;
