import Image from 'next/image';

interface CustomImageProps {
  src: string;
  alt?: string;
  width: number;
  height: number;
}

const CustomImage = ({ src, alt = ' ', width, height }: CustomImageProps) => (
  <Image src={src} alt={alt} width={width} height={height} />
);

export default CustomImage;
