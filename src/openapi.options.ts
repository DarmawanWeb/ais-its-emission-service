import type { OpenApiOptions } from '@darmawanweb/ais-its-nest';

import { SERVICE } from './service.js';

/** OpenAPI document of the service (`/docs`, `/openapi.json`, `pnpm openapi`). */
export const OPENAPI: OpenApiOptions = {
  title: `AIS Maritime Intelligence — ${SERVICE.title}`,
  version: SERVICE.version,
  description: SERVICE.description,
  tags: [
    {
      name: 'methodology',
      description: 'Methods of the methodology catalog implemented here',
    },
    { name: 'notes', description: 'Vessel notes of an organization (example)' },
  ],
};
