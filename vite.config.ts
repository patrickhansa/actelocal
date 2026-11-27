import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = dirname(fileURLToPath(import.meta.url));

// `vite preview` sends the same headers Cloudflare Pages applies from
// public/_headers, so CSP violations show up locally before a deploy.
// Assumes _headers holds a single `/*` block.
function productionHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const file = readFileSync(resolve(root, 'public/_headers'), 'utf8');
  for (const line of file.split(/\r?\n/)) {
    const match = /^\s+([\w-]+):\s*(.+)$/.exec(line);
    if (match) headers[match[1]] = match[2].trim();
  }
  return headers;
}

export default defineConfig({
  build: {
    rolldownOptions: {
      input: {
        home: resolve(root, 'index.html'),
        compressPdf: resolve(root, 'compress-pdf/index.html'),
        photosToPdf: resolve(root, 'photos-to-pdf/index.html'),
      },
    },
  },
  preview: {
    headers: productionHeaders(),
  },
});
