# ActeLocal

Free Romanian-language tools that get scans and phone photos under a portal's upload limit, entirely in the browser. No account, no upload, no server.

## Development

```sh
npm install
npm run dev       # local dev server; /dev/engine.html runs the engine on any file
npm test          # unit tests
npm run build     # type-check and build to dist/
npm run preview   # serve dist/ with the production headers from public/_headers
```

The compression engine lives in `src/engine/` and is described in [docs/engine-design.md](docs/engine-design.md). `scripts/bench.mjs` benchmarks it in headless Chrome (see the comment at its top).

## Deploy (Cloudflare Pages)

- Build command: `npm run build`
- Output directory: `dist`
- `public/_headers` sets a strict Content-Security-Policy (`connect-src 'self'`), so the page can't send your files anywhere, even through a bug.

## License

MIT
