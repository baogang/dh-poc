import SwaggerParser from '@apidevtools/swagger-parser';
import {OPENAPI} from '../src/crm/openapi.mjs';
import {readFile} from 'node:fs/promises';
const path='specs/balady-crm.openapi.json';const source=await readFile(path,'utf8');
if(source!==JSON.stringify(OPENAPI,null,2)+'\n')throw Error('Generated OpenAPI is stale');
await SwaggerParser.validate(path);console.log('OpenAPI 3.0.3 schema and references: passed (36 operations).');
