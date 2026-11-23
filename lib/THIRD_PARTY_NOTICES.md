# Library drawing dependencies

The RNL standard drawing packages `rnl-std-basic.rnl`, `rnl-std-semiconductors.rnl` and `rnl-std-spectre.rnl` derive from **rich-netlist/rnl**, upstream revision `a240fe6bd952a28d0b7497c5c394b6c04d1f6d9c`, copyright 2026 many-question. The upstream standard packages are dedicated under **CC0-1.0**; see [the complete dedication](licenses/CC0-1.0.txt).

The basic and semiconductor packages match the pinned viewer's standard/0.3 copies. The Spectre package retains its upstream generation/Analog Canvas attribution and includes local symbol-mapping adaptations. Per-file hashes in each cell's provenance identify the imported revision; filenames alone do not establish byte identity.

`eda-symbol.rnl`, `eda-style.rnl` and the user-cell `.rnl` icons are the local native export's generic drawing support. They contain drawing/style and terminal-mapping definitions, not PDK electrical models or standard-cell transistor implementations. They are retained as part of the user-authorized circuit export. No additional third-party license or upstream authorship is asserted for these local additions.

The runtime itself is distributed separately in `apps/web/vendor/rnl-viewer`: MIT code, CC0 standard packages, and OFL-1.1 Noto font metrics. Its original notices and license files remain in that directory. This library import does not copy runtime/font binaries or change their licenses.

Circuit topology may refer to external device/standard-cell master names. Those names do not grant redistribution of their implementations, process models, technology libraries or licenses. None of those implementations is included by the importer. The explicit empty `trans_ulvt_mac_pcell_0` interface is only a drawing dependency and has no electrical behavior.
