import type { OpenApiOptions } from '@darmawanweb/ais-its-nest';

import { SERVICE } from './service.js';

/** OpenAPI document of the service (`/docs`, `/openapi.json`, `pnpm openapi`). */
export const OPENAPI: OpenApiOptions = {
  title: `AIS Maritime Intelligence — ${SERVICE.title}`,
  version: SERVICE.version,
  description: SERVICE.description,
  tags: [
    {
      name: 'cii',
      description:
        'CII of vessels: year-to-date, daily, annual, segments, fleet summary, manual records, recomputation',
    },
    {
      name: 'reduction-factors',
      description:
        'Reduction factors Z of the required CII (MEPC.338(76), MEPC.400(83))',
    },
    {
      name: 'seemp',
      description:
        'SEEMP measures, recommendations, what-if simulation and saved scenarios',
    },
    {
      name: 'emission',
      description: 'IMO DCS-style annual summary (JSON or CSV)',
    },
    {
      name: 'methodology',
      description:
        'Methods of the methodology catalog implemented here (spec §17)',
    },
  ],
};
