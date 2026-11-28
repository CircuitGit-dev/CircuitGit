#!/usr/bin/env python3
"""Prepare a project-local developer Python, build packages and check them.

This command never starts a model, gateway, browser, SSH connection or solver.
It uses the integration lock and the existing bootstrap's isolated installer.
"""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'tools/workbench'))
import bootstrap_python as bootstrap
from upstream_sources import ensure_upstreams,UpstreamError

EXTRAS = ('adctools', 'mcp')
# -X utf8 keeps every step reading repository sources as UTF-8 regardless of the console
# codepage (GBK on Chinese Windows); -E only blocks UTF-8 mode through environment variables.
STEPS = (
    ('dependencies', ['-I', '-B', '-m', 'pip', 'check'], 120),
    ('build', ['-X', 'utf8', '-E', '-s', '-B', 'tools/dev/build.py', 'all'], 180),
    ('pages', ['-X', 'utf8', '-E', '-s', '-B', 'tools/dev/build_pages.py'], 180),
    ('structure', ['-X', 'utf8', '-E', '-s', '-B', 'tools/dev/check_structure.py'], 120),
    ('links', ['-X', 'utf8', '-E', '-s', '-B', 'tools/dev/check_links.py'], 120),
)


def artifact_health(root):
    outputs = {}
    for relative, kind, entry in [('web','web','studio/index.html'),
                                  ('dist/ic-workbench','codex','ic_workbench.py'),
                                  ('site','web','index.html')]:
        folder = root / relative
        if folder.is_symlink() or not bootstrap.within(folder, root):
            raise bootstrap.BootstrapError('构建目录超出当前项目：' + relative)
        try:
            marker = json.loads((folder / '.ic-build.json').read_text(encoding='utf-8'))
            valid = (marker.get('schema') == 'ic.build.v1' and marker.get('kind') == kind
                     and type(marker.get('files')) is int and marker['files'] > 0
                     and (folder / entry).is_file())
        except (OSError, ValueError, TypeError):
            valid = False
        if not valid:
            raise bootstrap.BootstrapError('构建产物核验失败：' + relative)
        outputs[relative] = {'entry': entry, 'files': marker['files']}
    return outputs


def save_receipt(root, value):
    folder = root / '.local'
    if folder.is_symlink() or not bootstrap.within(folder, root):
        raise bootstrap.BootstrapError('项目 .local 指向其他位置；未保存开发环境回执。')
    folder.mkdir(mode=0o700, exist_ok=True)
    target = folder / 'developer-setup.json'
    if target.is_symlink():
        raise bootstrap.BootstrapError('开发环境回执不能指向其他文件。')
    descriptor, temporary = tempfile.mkstemp(prefix='.developer-setup-', dir=folder)
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
            json.dump(value, stream, indent=2, ensure_ascii=False)
            stream.write('\n')
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):os.unlink(temporary)


def setup(root=ROOT, *, python=None, run=None, ensure=None, progress=None):
    root = Path(root).resolve()
    run = run or subprocess.run
    ensure = ensure or bootstrap.ensure_python
    progress = progress or (lambda text: print('[CircuitGit setup] ' + text, file=sys.stderr, flush=True))
    pin = bootstrap.read_pin(root)
    # The bootstrap's lock protects installation. Keep builds/health in a second
    # project-local lock so two setup commands cannot replace generated output.
    if not bootstrap.within(root / '.local/developer-setup', root):
        raise bootstrap.BootstrapError('开发环境锁目录超出当前项目。')
    with bootstrap.setup_lock(root / '.local/developer-setup'):
        try:upstreams=ensure_upstreams(root,run=run,progress=progress)
        except UpstreamError as error:raise bootstrap.BootstrapError(str(error)) from error
        interpreter = ensure(root, run=run, candidates=[Path(python)] if python else None,
                             extras=EXTRAS, progress=progress)
        stages = [{'stage':'upstreams','status':upstreams['status']}]
        for name, arguments, timeout in STEPS:
            progress(name)
            bootstrap.checked([interpreter, *arguments], name + ' ', run, root, timeout)
            stages.append({'stage': name, 'status': 'passed'})
        report = {'schema':'circuitgit.developer-setup.v1','status':'ready',
                  'checked_at':datetime.now(timezone.utc).isoformat(),
                  'python':str(interpreter),'spiceowl':pin,'extras':list(EXTRAS),
                  'upstreams':upstreams,
                  'adctoolbox_version':'0.9.3','checks':stages,'artifacts':artifact_health(root),
                  'external_links_checked':False,'services_started':False,
                  'model_calls':0,'ssh_calls':0,'solver_invocations':0}
        save_receipt(root, report)
        return report


def main(argv=None, *, root=ROOT):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--python', type=Path, help='Python 3.11+ used only if a new environment is needed')
    parser.add_argument('--plan', action='store_true', help='Print the setup plan without installing, building or writing')
    options = parser.parse_args(argv)
    try:
        if options.plan:
            report = {'schema':'circuitgit.developer-setup-plan.v1',
                      'spiceowl':bootstrap.read_pin(Path(root)),'extras':list(EXTRAS),
                      'adctoolbox_version':'0.9.3',
                      'stages':['official upstream submodule verification and initialization', 'project-local Python installation', *[name for name, _args, _timeout in STEPS], 'artifact health'],
                      'services_started':False}
        else:
            report = setup(root, python=options.python)
    except (bootstrap.BootstrapError, OSError, ValueError) as error:
        print('[CircuitGit setup] ' + str(error), file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print('[CircuitGit setup] 已中断；已有项目环境和回执保留，可重新执行此命令。', file=sys.stderr)
        return 130
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0


if __name__ == '__main__':raise SystemExit(main())
