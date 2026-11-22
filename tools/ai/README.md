# Compatibility entry

The maintained plugin/CLI source is now [`apps/codex`](../../apps/codex/README.md). Shared gateway operations live in [`modules/gateway_client`](../../modules/gateway_client/ic_gateway/service.py).

`python3 -B tools/ai/ic_workbench.py …` and legacy `icwb` imports/tests remain supported. New integrations should use `apps/codex/ic_workbench.py`. Build a portable plugin with `python3 -B tools/dev/build.py codex`; copy `dist/ic-workbench/`, not this compatibility folder.

No global plugin or authentication settings are changed by the reorganization. See [architecture](../../docs/architecture.md).
