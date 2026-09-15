/**
 * Local type declarations for @icons-pack/react-simple-icons sub-path imports.
 *
 * The package's barrel (index.d.ts) re-exports 3,228 individual icon files,
 * causing TypeScript to OOM during type-checking. We import from sub-paths
 * (e.g. `@icons-pack/react-simple-icons/icons/SiJira`) but the package's
 * `./icons/*` wildcard export lacks explicit `types` conditions, so TypeScript
 * can't resolve them automatically. These ambient declarations fix that without
 * loading the barrel.
 *
 * NOTE: This file must have no top-level imports — it must remain a "script"
 * (non-module) file so that `declare module` blocks are ambient declarations
 * rather than augmentations of existing modules.
 */

declare module '@icons-pack/react-simple-icons/icons/SiAtlassian' {
  import type React from 'react';
  const SiAtlassian: React.ForwardRefExoticComponent<
    React.SVGProps<SVGSVGElement> & {
      title?: string;
      color?: string;
      size?: string | number;
    } & React.RefAttributes<SVGSVGElement>
  >;
  const defaultColor: string;
  export { SiAtlassian as default, defaultColor };
}

declare module '@icons-pack/react-simple-icons/icons/SiGoogledrive' {
  import type React from 'react';
  const SiGoogledrive: React.ForwardRefExoticComponent<
    React.SVGProps<SVGSVGElement> & {
      title?: string;
      color?: string;
      size?: string | number;
    } & React.RefAttributes<SVGSVGElement>
  >;
  const defaultColor: string;
  export { SiGoogledrive as default, defaultColor };
}

declare module '@icons-pack/react-simple-icons/icons/SiJira' {
  import type React from 'react';
  const SiJira: React.ForwardRefExoticComponent<
    React.SVGProps<SVGSVGElement> & {
      title?: string;
      color?: string;
      size?: string | number;
    } & React.RefAttributes<SVGSVGElement>
  >;
  const defaultColor: string;
  export { SiJira as default, defaultColor };
}

declare module '@icons-pack/react-simple-icons/icons/SiNotion' {
  import type React from 'react';
  const SiNotion: React.ForwardRefExoticComponent<
    React.SVGProps<SVGSVGElement> & {
      title?: string;
      color?: string;
      size?: string | number;
    } & React.RefAttributes<SVGSVGElement>
  >;
  const defaultColor: string;
  export { SiNotion as default, defaultColor };
}

declare module '@icons-pack/react-simple-icons/icons/SiOkta' {
  import type React from 'react';
  const SiOkta: React.ForwardRefExoticComponent<
    React.SVGProps<SVGSVGElement> & {
      title?: string;
      color?: string;
      size?: string | number;
    } & React.RefAttributes<SVGSVGElement>
  >;
  const defaultColor: string;
  export { SiOkta as default, defaultColor };
}
