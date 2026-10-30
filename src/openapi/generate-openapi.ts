import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createOpenApiDocument } from './openapi-document.js';

const document = await createOpenApiDocument();
await writeFile(resolve(process.cwd(), 'openapi.json'), `${JSON.stringify(document, null, 2)}\n`, { mode: 0o644 });
