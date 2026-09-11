# Local Markdown dependency

- Package: `markdown-it` 15.0.2 (MIT).
- Source: https://cdn.jsdelivr.net/npm/markdown-it@15.0.2/dist/browser/markdown-it.umd.min.js
- Upstream: https://github.com/markdown-it/markdown-it
- License: `markdown-it.LICENSE`, preserved from the published package.
- Local bundle: `markdown-it.min.js` (published bundle with a final newline).
- SHA-256: `5db01135d186fea4041bd33e0ec0415111bee291a209ba9e819a8b66f35cf5a4`.

This browser bundle includes its runtime dependencies. No npm installation,
frontend build, or CDN connection is required to use the viewer. The source map
referenced by the upstream bundle is not included. Keep this directory beside
the viewer files when copying the app. Renderer options and link/image policies
are configured separately in `../chat-markdown.js`.
