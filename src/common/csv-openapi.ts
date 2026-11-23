import { applyDecorators, type Type } from '@nestjs/common';
import {
  ApiExtraModels,
  ApiOkResponse,
  type HeadersObject,
  type ReferenceObject,
  type SchemaObject,
} from '@nestjs/swagger';

import { TRUNCATED_HEADER } from './csv.js';

/** Options of {@link ApiJsonOrCsvResponse}. */
export interface JsonOrCsvResponseOptions {
  /** What the `200` holds. */
  readonly description: string;
  /** Schema of the JSON body. */
  readonly json: SchemaObject | ReferenceObject;
  /** Classes the JSON schema references with `getSchemaPath`. */
  readonly models: readonly Type<unknown>[];
  /** Example of the CSV body (at least its header line). */
  readonly csvExample: string;
  /** `filename` of the CSV's `Content-Disposition: attachment`. */
  readonly filename: string;
  /** When the CSV may be cut at a row limit: the condition of `X-Truncated: true`. */
  readonly truncatedWhen?: string;
}

/**
 * Documents the `200` of a route that answers JSON or, with
 * `Accept: text/csv`, a CSV file (content negotiation): the JSON schema only
 * under `application/json`, a string under `text/csv`, and the headers the
 * CSV is sent with. `@ApiProduces('application/json', 'text/csv')` with a
 * typed response would attach the JSON schema to the CSV too, and generated
 * clients would type the download as a JSON object.
 */
export function ApiJsonOrCsvResponse(
  options: JsonOrCsvResponseOptions,
): MethodDecorator & ClassDecorator {
  const headers: HeadersObject = {
    'Content-Disposition': {
      description: `CSV only: \`attachment; filename="${options.filename}"\``,
      schema: { type: 'string' },
    },
  };
  if (options.truncatedWhen !== undefined) {
    headers[TRUNCATED_HEADER] = {
      description: `CSV only: \`true\` when ${options.truncatedWhen}, else \`false\``,
      schema: { type: 'string', enum: ['true', 'false'] },
    };
  }
  return applyDecorators(
    ApiExtraModels(...options.models),
    ApiOkResponse({
      description: options.description,
      content: {
        'application/json': { schema: options.json },
        'text/csv': {
          schema: { type: 'string' },
          example: options.csvExample,
        },
      },
      headers,
    }),
  );
}
