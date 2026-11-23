import type { CorsFeatureOptions } from '@darmawanweb/ais-its-nest/http';

import { TRUNCATED_HEADER } from './common/csv.js';

/**
 * CORS of the service, used by `server.ts` and the tests: besides the kit's
 * defaults (`X-Request-Id`, `Retry-After`, `WWW-Authenticate`, `ETag`,
 * `Location`), cross-origin browser clients may read the file name of the
 * CSV exports (`Content-Disposition`: DCS, fleet DCS, segments) and
 * `X-Truncated` of the segment CSV.
 */
export const EMISSION_CORS: CorsFeatureOptions = {
  exposedHeaders: ['Content-Disposition', TRUNCATED_HEADER],
};
