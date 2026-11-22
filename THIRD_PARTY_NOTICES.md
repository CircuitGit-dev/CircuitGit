# Third-party notices

CircuitGit's MIT license applies to original project code. Bundled third-party works retain their own notices and licenses.

- **Rich Netlist (RNL)** — schematic/netlist renderer and WebAssembly core by many-question and contributors. MIT. Source: https://github.com/rich-netlist/rnl. Pinned upstream metadata: `apps/web/vendor/rnl-viewer/provenance.json`. Licenses: `apps/web/vendor/rnl-viewer/LICENSE`, `core/LICENSE`, and the viewer's `THIRD_PARTY_NOTICES.md`.
- **rnl-virtuoso exporter tooling** — retained notices in `tools/native_geometry/exporter-LICENSE`; local changes are described in the native geometry documentation.
- **Dockview** — panel layout component by mathuo and contributors. MIT. License and provenance: `apps/web/vendor/dockview/LICENSE` and `provenance.json`.
- **Fonts and symbols** bundled with RNL retain their upstream notices, including SIL Open Font License and CC0 files in the viewer's `fonts/` and `LICENSES/` directories.
- The optional MCP adapter declares its SDK dependencies under `apps/mcp/`. Those packages are installed separately and retain their respective licenses.

Cadence tools, PDK/model files, account credentials, and proprietary circuit datasets are not distributed. Product references describe interoperability and do not imply affiliation or endorsement.
