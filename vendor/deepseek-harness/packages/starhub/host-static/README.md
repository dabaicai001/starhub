# @deepseek-ai/dsh-starhub-host-static

StarHub-local host plugin (not upstream). Registers the `/starhub-react` prefix route on the dsh `webServer` for the standalone React workbench window app (`npm run build:window` → repo `dist-starhub-react/`, vite base `/starhub-react/`). Independent windows opened for Tools instance clicks load this entry and reuse the client-nav React workbenches full-window.

The plugin resolves the dist in this order: the `windowDist` Config field, `STARHUB_WINDOW_DIST`, then repo `dist-starhub-react` (the repo root is found by walking up to the directory containing `vendor/deepseek-harness`). Its `index.html` must reference `/starhub-react`-prefixed assets; a wrong base fails loud on the Config/env tier and is skipped on the repo tier. A missing build fails plugin startup.

The `windowDist` Config field exists for the installed shell: the M4 provisioning script (`scripts/provision-dsh.mjs` in the StarHub repo) installs the workbench dist under `$DSH_HOME/starhub/resources/starhub-react` and writes that absolute path into the profile patch, so an installed shell never depends on a StarHub checkout being present.

Responses are cache-aware: Vite content-hashed files under `assets/` get `public, max-age=31536000, immutable`, while `index.html` and unhashed files get `no-cache`, so an install or update never serves a stale entry document against new hashes. A missing path with a file extension answers 404 instead of the SPA fallback; extension-less misses still return `index.html` for in-app routes. `HEAD` sends headers only, and a malformed percent escape answers 400.

## Model Experience

### Static workbench hosting

#### What the model sees

Nothing — the plugin only serves the `/starhub-react` web build over the dsh `webServer`; it registers no prompt, tool, or message surface.

#### Token effect

None — no model-request participation.

#### KV Cache effect

Not applicable.

## Known Limitations and Deferred Work

- Responses are not compressed; the workbench build ships uncompressed JS/CSS and the host web server forwards them as-is.
