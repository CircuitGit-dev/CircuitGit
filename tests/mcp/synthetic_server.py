"""Subprocess fixture: NO real gateway, model, approval, source edit or simulation."""
import argparse
import copy
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT/'apps/mcp'), str(ROOT/'tests/codex')]
from server import create_adapter
from test_views import FakeService
from icwb.service import Failure, atom, canonical
from icwb.views import ViewService
from icwb.view_contracts import RESOURCES


class SyntheticService(FakeService):
    def __init__(self, state):
        super().__init__(state)
        self.resolutions = []

    def call(self, op, args):
        print('SYNTHETIC diagnostic from service; must not corrupt stdio')
        if op == 'projects':
            return {**self.registry(), 'synthetic_resolution_count': len(self.resolutions)}
        if op == 'read' and args.get('scope') == 'SYNTHETIC-block':
            import time
            time.sleep(0.3)
        return super().call(op, args)

    def resolve(self, request_id, decision, fingerprint):
        # Test-only human stand-in, never used by the production entrypoint.
        receipt = self.receipts[request_id]
        if receipt['fingerprint'] != fingerprint:
            raise Failure('conflict', 'SYNTHETIC fingerprint mismatch')
        if receipt['state'] != 'pending_approval':
            return copy.deepcopy(receipt)
        self.resolutions.append(decision)
        receipt['state'] = 'accepted' if decision == 'approve' else 'denied'
        atom(self.state/'SYNTHETIC-resolutions.json', self.resolutions)
        return copy.deepcopy(receipt)


class SyntheticLifecycle:
    tool_names = {'ic_plugin_status', 'ic_plugin_connect'}
    def __init__(self): self.ensure_count = 0
    def tools(self):
        from icwb.plugin_runtime import PluginRuntime
        return PluginRuntime.tools(self)
    def ensure(self):
        self.ensure_count += 1
        print('SYNTHETIC runtime ensure, no startup')
        return {'fixture': 'SYNTHETIC', 'ensures': self.ensure_count}
    def call(self, name, args):
        if args != {}: raise Failure('invalid_input', 'No lifecycle arguments')
        return self.ensure() if name == 'ic_plugin_connect' else {'fixture': 'SYNTHETIC', 'ensures': self.ensure_count}


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--state', type=Path, required=True)
    p.add_argument('--review-timeout', type=float, default=1.5)
    args = p.parse_args()
    service = SyntheticService(args.state)
    ui = args.state/'ui'; ui.mkdir()
    for kind in RESOURCES:
        (ui/(kind+'.html')).write_text('<!doctype html><title>SYNTHETIC '+kind+'</title>')
    adapter = create_adapter(service, views=ViewService(service, ui), lifecycle=SyntheticLifecycle(), review_timeout=args.review_timeout)
    import anyio
    anyio.run(adapter.serve)


if __name__ == '__main__': main()
