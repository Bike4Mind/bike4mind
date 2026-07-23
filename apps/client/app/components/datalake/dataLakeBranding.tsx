import WaterOutlinedIcon from '@mui/icons-material/WaterOutlined';
import type { ComponentProps } from 'react';

/**
 * Single source of truth for the Data Lake name + icon. Every surface (sidenav,
 * gears, Files manager, session "Send to ..." menus, wizard) imports from here so
 * the label and glyph stay identical everywhere. The premium OptiHashi overlay
 * adopts the same tokens via `@client/app/components/datalake/dataLakeBranding`.
 *
 * WaterOutlined is deliberately chosen over Storage: it is lake-exclusive, whereas
 * Storage is reused for admin/database/research surfaces and so cannot uniquely
 * signal a Data Lake.
 */

/** Singular noun - use for actions and single-lake contexts ("Send to Data Lake"). */
export const DATA_LAKE = 'Data Lake';

/** Plural / collection - use for the nav destination and the manager header. */
export const DATA_LAKES = 'Data Lakes';

/** The canonical Data Lake icon. Forwards `sx`/`fontSize`/etc. to the underlying icon. */
export const DataLakeIcon = (props: ComponentProps<typeof WaterOutlinedIcon>) => <WaterOutlinedIcon {...props} />;
