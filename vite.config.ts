/// <reference types="vitest/config" />
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

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

// pdf.js loads its WebAssembly image decoders (JBIG2, JPEG 2000, colour
// profiles) at runtime from a fixed directory URL with fixed file names, so
// they can't go through Vite's hashed asset pipeline. This plugin serves them
// at /pdfjs/wasm/ in dev and copies them there in the build.
// QuickJS is skipped: it only runs JavaScript embedded in PDFs, which we never enable.
function pdfjsWasm(): Plugin {
  const sourceDir = resolve(root, 'node_modules/pdfjs-dist/wasm');
  const urlPrefix = '/pdfjs/wasm/';
  const files = () => readdirSync(sourceDir).filter((name) => !/quickjs/i.test(name));
  const contentType = (name: string) =>
    name.endsWith('.wasm') ? 'application/wasm' : name.endsWith('.js') ? 'text/javascript' : 'text/plain';

  return {
    name: 'pdfjs-wasm',
    configureServer(server) {
      server.middlewares.use(urlPrefix, (req, res, next) => {
        const name = basename((req.url ?? '').split('?')[0]);
        const file = resolve(sourceDir, name);
        if (!name || !files().includes(name) || !existsSync(file)) return next();
        res.setHeader('Content-Type', contentType(name));
        res.end(readFileSync(file));
      });
    },
    generateBundle() {
      for (const name of files()) {
        this.emitFile({ type: 'asset', fileName: `pdfjs/wasm/${name}`, source: readFileSync(resolve(sourceDir, name)) });
      }
    },
  };
}

const pages = {
  home: resolve(root, 'index.html'),
  compressPdf: resolve(root, 'compress-pdf/index.html'),
  photosToPdf: resolve(root, 'photos-to-pdf/index.html'),
};

// `--mode harness` also builds the dev harness, into dist-harness/, so the engine can be
// tested under the production CSP with `vite preview --mode harness`. Never deployed.
export default defineConfig(({ mode }) => ({
  plugins: [pdfjsWasm()],
  build: {
    outDir: mode === 'harness' ? 'dist-harness' : 'dist',
    rolldownOptions: {
      input: mode === 'harness' ? { ...pages, harness: resolve(root, 'dev/engine.html') } : pages,
    },
  },
  preview: {
    headers: productionHeaders(),
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
}));
