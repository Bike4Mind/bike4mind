/**
 * Historical name for the shared mode breadcrumb, kept so the premium /opti mode
 * sub-views keep their import path. The implementation is the brand-agnostic
 * `SurfaceBreadcrumb`; new callers should import that directly.
 */
export { SurfaceBreadcrumb as OptiModeBreadcrumb } from '@client/app/components/datalake/SurfaceBreadcrumb';
