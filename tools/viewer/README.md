# RNL vendor source and build references

Current renderer: `apps/web/vendor/rnl-viewer/`. Its `provenance.json` and `upstream-lock.json` retain upstream identity and reviewed local patches. The runtime build copies these assets without re-fetching upstream.

`patches/ic-selection-bridge.js` is a patch template evaluated only after copying beside the vendor modules. It is not an independently runnable web module. `historical-viewer-dependencies.json` records the earlier pre-Studio delivery inventory; it is historical evidence, not the current web build manifest. Current build files/hashes are generated in `web/asset-manifest.json`.

`build-viewer.mjs` is the earlier pinned upstream import helper. Do not run it over the current customized renderer; a fresh upstream import must preserve/review Studio and context adaptations and update provenance deliberately. See `docs/architecture.md`.

`patches/selected-instance-properties.mjs` replays the selected-instance status-bar adaptation against the exact reviewed `selection.js` base hash. The upstream import helper applies it before generating its inventory. Shared parameter inspection remains in `modules/schematic/instance-properties.js`; the normal web build rewrites that source import for the published asset layout.

To apply just this adaptation to the current packaged renderer and refresh its two affected inventory rows, run `node tools/viewer/apply-selection-properties.mjs`. The command preserves the upstream pin and earlier adaptation records, refuses unrelated vendor changes, and is idempotent. It does not download upstream or overwrite the existing renderer with a fresh import. Validate with `node tests/viewer-vendor.test.mjs` afterward.
