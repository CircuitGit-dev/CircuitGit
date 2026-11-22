"""Stable CLI; JSON envelopes, no implicit mutation approval."""
import argparse
import json
import os
from pathlib import Path
import sys
from .service import Failure, SCHEMAS, Service, canonical, load_config, tools


def emit(data, as_json, operation):
    if as_json:
        print(canonical({'schema': 'ic.workbench.response.v1', 'ok': True, 'operation': operation, 'data': data}))
    elif isinstance(data, dict) and 'diff' in data:
        print(data['diff'], end='')
        print('\nReview: ' + data['review_id'])
        print('Validation: ' + canonical(data.get('validation', {})))
    else:
        print(json.dumps(data, ensure_ascii=False, indent=2))


def main(argv=None):
    p = argparse.ArgumentParser(description='IC Workbench: controlled gateway CLI / MCP / local AI bridge')
    p.add_argument('--config', default=os.environ.get('IC_WORKBENCH_CONFIG'))
    p.add_argument('--json', action='store_true')
    sub = p.add_subparsers(dest='command', required=True)
    sub.add_parser('schema', help='Print supported tool schemas without connecting')
    sub.add_parser('mcp', help='Start MCP stdio server (stdout is protocol only)')
    sub.add_parser('doctor', help='Check gateway and normal Codex account status; no turn')
    serve = sub.add_parser('serve-ai', help='Start isolated loopback AI host; leaves existing gateway intact')
    serve.add_argument('--port', type=int, default=8767)
    for op, schema in SCHEMAS.items():
        q = sub.add_parser(op.replace('_', '-'))
        for key in schema['properties']:
            q.add_argument('--' + key.replace('_', '-'), required=key in schema['required'],
                           help='Path to a JSON array of full replacements' if key == 'changes' else None)
    for action in ('approve', 'deny'):
        q = sub.add_parser(action, help='Human-only resolution of a previously displayed request')
        q.add_argument('--request-id', required=True)
        q.add_argument('--fingerprint', required=True, help='Exact fingerprint from displayed request')
    a = p.parse_args(argv)
    try:
        if a.command == 'schema':
            emit({'tools': tools()}, a.json, 'schema'); return 0
        service = Service(load_config(a.config))
        if a.command == 'mcp':
            from .mcp import run
            return run(service)
        if a.command in ('doctor', 'serve-ai'):
            from .ai import AiSession
            if a.command == 'doctor':
                session = AiSession(service)
                try: result = session.doctor()
                finally: session.close()
                emit(result, a.json, 'doctor'); return 0
            from .host import serve
            return serve(service, a.port)
        op = a.command.replace('-', '_')
        if op in ('approve', 'deny'):
            result = service.resolve(a.request_id, op, a.fingerprint)
        else:
            arguments = {k: getattr(a, k) for k in SCHEMAS[op]['properties'] if getattr(a, k) is not None}
            if 'changes' in arguments:
                arguments['changes'] = json.loads(Path(arguments['changes']).read_text())
            result = service.call(op, arguments)
        emit(result, a.json, op)
        state = result.get('state') if isinstance(result, dict) else None
        return 10 if state == 'pending_approval' else 75 if state in ('uncertain', 'dispatching') else 4 if state in ('denied', 'rejected') else 0
    except Failure as e:
        print(canonical({'schema': 'ic.workbench.response.v1', 'ok': False, 'error': e.record()}), file=sys.stdout if a.json else sys.stderr)
        return e.exit_code
    except (ValueError, OSError) as e:
        print(canonical({'ok': False, 'error': {'code': 'local_configuration', 'message': str(e), 'exit_code': 2}}), file=sys.stdout if a.json else sys.stderr)
        return 2
