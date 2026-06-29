import { defineConfig } from '@hey-api/openapi-ts';

// We only need the TypeScript type definitions from the spec — the library
// speaks the WebSocket v2 protocol directly, not the HTTP SDK. The custom
// pass in scripts/generate.ts builds the action catalog and notification
// type map on top of these types.
export default defineConfig({
  input: './openapi.json',
  output: {
    path: './src/generated/openapi',
  },
  plugins: ['@hey-api/typescript'],
});
