import { FC, SVGAttributes } from 'react';

const IndiaFlag: FC<SVGAttributes<SVGSVGElement>> = props => {
  return (
    <svg {...props} viewBox="0 0 22 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <g clipPath="url(#clip0_2_1013)">
        <g clipPath="url(#clip1_2_1013)">
          <rect width="22" height="16" rx="2" fill="white" />
          <path
            fillRule="evenodd"
            clipRule="evenodd"
            d="M11 10.6666C12.4457 10.6666 13.6191 9.47198 13.6191 7.99998C13.6191 6.52798 12.4457 5.33331 11 5.33331C9.55431 5.33331 8.38098 6.52798 8.38098 7.99998C8.38098 9.47198 9.55431 10.6666 11 10.6666ZM11 9.59998C11.8675 9.59998 12.5715 8.88318 12.5715 7.99998C12.5715 7.11678 11.8675 6.39998 11 6.39998C10.1326 6.39998 9.4286 7.11678 9.4286 7.99998C9.4286 8.88318 10.1326 9.59998 11 9.59998Z"
            fill="#1A47B8"
          />
          <path
            d="M11 8.53334C11.2893 8.53334 11.5238 8.29456 11.5238 8.00001C11.5238 7.70546 11.2893 7.46667 11 7.46667C10.7107 7.46667 10.4762 7.70546 10.4762 8.00001C10.4762 8.29456 10.7107 8.53334 11 8.53334Z"
            fill="#1A47B8"
          />
          <path fillRule="evenodd" clipRule="evenodd" d="M0 11H22V16H0V11Z" fill="#249F58" />
          <path fillRule="evenodd" clipRule="evenodd" d="M0 0H22V5H0V0Z" fill="#FF6C2D" />
        </g>
      </g>
      <defs>
        <clipPath id="clip0_2_1013">
          <rect width="22" height="16" fill="white" />
        </clipPath>
        <clipPath id="clip1_2_1013">
          <rect width="22" height="16" rx="2" fill="white" />
        </clipPath>
      </defs>
    </svg>
  );
};
export default IndiaFlag;
