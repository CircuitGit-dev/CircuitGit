#!/usr/bin/env python3
"""Unified cross-platform test runner for CircuitGit (macOS, Windows, Linux).

Runs architecture/cross-platform guards, builds, backend/gateway/library/AI/
simulation suites, and Node.js frontend tests with one command so developers,
users, and CI verify the exact same matrix.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'tools/workbench'))
import local_sim  # noqa: E402
import platform_compat  # noqa: E402


def _python_env():
    env = dict(os.environ)
    paths = [
        str(ROOT / 'tools/workbench'),
        str(ROOT / 'tools/dev'),
        str(ROOT / 'tools/ci'),
        str(ROOT / 'apps/codex'),
        str(ROOT / 'modules/gateway_client'),
    ]
    existing = env.get('PYTHONPATH')
    env['PYTHONPATH'] = os.pathsep.join(paths + ([existing] if existing else []))
    env['PYTHONDONTWRITEBYTECODE'] = '1'
    env['PYTHONUTF8'] = '1'
    return env


def _has_module(name):
    return importlib.util.find_spec(name) is not None


def _configure_stdio():
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            try:
                stream.reconfigure(encoding='utf-8', errors='replace')
            except OSError:
                pass


def _run_step(name, cmd, *, env=None, cwd=ROOT):
    started = time.monotonic()
    proc = subprocess.run(
        [str(part) for part in cmd],
        cwd=str(cwd),
        env=env,
        capture_output=True,
        text=True,
        encoding='utf-8',
        errors='replace',
    )
    elapsed = round(time.monotonic() - started, 2)
    stdout_lines = proc.stdout.strip().splitlines()
    stderr_lines = proc.stderr.strip().splitlines()
    fail_lines = [l for l in stdout_lines if l.lstrip().startswith(('not ok ', 'Error:', 'AssertionError'))]
    return {
        'name': name,
        'ok': proc.returncode == 0,
        'returncode': proc.returncode,
        'seconds': elapsed,
        'command': ' '.join(str(part) for part in cmd),
        'stdout_tail': (fail_lines[-15:] + stdout_lines[-12:]) if fail_lines else stdout_lines[-12:],
        'stderr_tail': stderr_lines[-20:],
    }


def _collect_node_tests(patterns):
    files = []
    for pattern in patterns:
        files.extend(sorted(ROOT.glob(pattern)))
    seen = set()
    ordered = []
    for path in files:
        rel = path.relative_to(ROOT).as_posix()
        if rel not in seen and path.is_file():
            seen.add(rel)
            ordered.append(rel)
    return ordered


def _py_unit(rel_path):
    return [sys.executable, '-B', '-m', 'unittest', '-v', rel_path]


def _py_script(rel_path, *args):
    return [sys.executable, '-B', rel_path, *args]


def build_plan(*, quick=False, include_spiceowl=False, has_node=True):
    py_ver = sys.version_info[:2]
    plan = {}

    # 1. Architecture, cross-platform guards, builds, packaging, and link audits.
    arch_steps = [
        ('check_structure (cross-platform & imports)', _py_script('tools/dev/check_structure.py')),
        ('build all (web + codex)', _py_script('tools/dev/build.py', 'all')),
        ('build_pages (static site)', _py_script('tools/dev/build_pages.py')),
        ('check_links (docs audit)', _py_script('tools/dev/check_links.py')),
        ('tests/architecture/test_cross_platform.py', _py_script('tests/architecture/test_cross_platform.py')),
        ('tests/architecture/test_structure.py', _py_script('tests/architecture/test_structure.py')),
        ('tests/codex_ui/test_packaging.py', _py_script('tests/codex_ui/test_packaging.py')),
    ]
    if not quick:
        arch_steps.extend([
            ('tests/architecture/test_links.py', _py_script('tests/architecture/test_links.py')),
            ('tests/architecture/test_setup_env.py', _py_script('tests/architecture/test_setup_env.py')),
            ('tests/architecture/test_sim_compat.py', _py_script('tests/architecture/test_sim_compat.py')),
            ('tests/codex_ui/test_gateway_pool_packaging.py', _py_script('tests/codex_ui/test_gateway_pool_packaging.py')),
            ('tests/workflow/test_evidence.py', _py_script('tests/workflow/test_evidence.py')),
        ])
    plan['architecture'] = arch_steps

    # 2. Launcher, bootstrap, browser helper, pairing, remote node, developer mode.
    remote_steps = [
        ('tests/remote/test_helper.py', _py_script('tests/remote/test_helper.py')),
        ('tests/remote/test_node.py', _py_script('tests/remote/test_node.py')),
        ('tests/remote/test_connector_install.py', _py_script('tests/remote/test_connector_install.py')),
        ('tools/workbench/test_bootstrap_python.py', _py_unit('tools/workbench/test_bootstrap_python.py')),
        ('tools/workbench/test_launch.py', _py_unit('tools/workbench/test_launch.py')),
        ('tools/workbench/test_onboarding_launcher.py', _py_unit('tools/workbench/test_onboarding_launcher.py')),
    ]
    if not quick:
        remote_steps.extend([
            ('tests/remote/test_pairing.py', _py_script('tests/remote/test_pairing.py')),
            ('tests/remote/test_development.py', _py_script('tests/remote/test_development.py')),
            ('tests/remote/test_library.py', _py_script('tests/remote/test_library.py')),
            ('tests/remote/test_organization_migration.py', _py_script('tests/remote/test_organization_migration.py')),
            ('tools/workbench/test_upstream_sources.py', _py_unit('tools/workbench/test_upstream_sources.py')),
        ])
    plan['remote'] = remote_steps

    # 3. Local open-source SPICE (ngspice/Xyce + open PDKs), runner, monitoring, waveforms.
    sim_steps = [
        ('tools/workbench/test_local_opensource_sim.py', _py_unit('tools/workbench/test_local_opensource_sim.py')),
        ('tools/workbench/test_rnl_sync_and_probes.py', _py_unit('tools/workbench/test_rnl_sync_and_probes.py')),
        ('tools/workbench/test_backend.py', _py_unit('tools/workbench/test_backend.py')),
        ('tools/workbench/test_audit_transport_and_dispatch_log.py', _py_unit('tools/workbench/test_audit_transport_and_dispatch_log.py')),
        ('tests/waveforms/test_dataset_routes.py', _py_script('tests/waveforms/test_dataset_routes.py')),
    ]
    if not quick:
        sim_steps.extend([
            ('tools/workbench/test_projects.py', _py_unit('tools/workbench/test_projects.py')),
            ('tools/workbench/test_runner_collection.py', _py_unit('tools/workbench/test_runner_collection.py')),
            ('tools/workbench/test_runner_execution_binding.py', _py_unit('tools/workbench/test_runner_execution_binding.py')),
            ('tools/workbench/test_simulation_derivation.py', _py_unit('tools/workbench/test_simulation_derivation.py')),
            ('tools/workbench/test_simulation_monitor.py', _py_unit('tools/workbench/test_simulation_monitor.py')),
            ('tools/workbench/test_simulation_monitor_authority.py', _py_unit('tools/workbench/test_simulation_monitor_authority.py')),
            ('tools/workbench/test_simulation_response_limit.py', _py_unit('tools/workbench/test_simulation_response_limit.py')),
            ('tools/workbench/test_simulation_runtime.py', _py_unit('tools/workbench/test_simulation_runtime.py')),
            ('tools/workbench/test_supervision.py', _py_unit('tools/workbench/test_supervision.py')),
        ])
    plan['simulation'] = sim_steps

    # 4. Circuit libraries, CRUD, branches, multi-cell PR, studio version control.
    library_steps = [
        ('tests/library/test_workflow_crud_branches.py', _py_script('tests/library/test_workflow_crud_branches.py')),
        ('tests/library/test_build_library.py', _py_script('tests/library/test_build_library.py')),
        ('tests/studio/test_library_sources.py', _py_script('tests/studio/test_library_sources.py')),
    ]
    if not quick:
        library_steps.extend([
            ('tests/library/test_ci.py', _py_script('tests/library/test_ci.py')),
            ('tests/library/test_deduplicate.py', _py_script('tests/library/test_deduplicate.py')),
            ('tests/library/test_history_build.py', _py_script('tests/library/test_history_build.py')),
            ('tests/library/test_inverter_example.py', _py_script('tests/library/test_inverter_example.py')),
            ('tests/library/test_research_simulation.py', _py_script('tests/library/test_research_simulation.py')),
            ('tests/library/test_testbench_ci.py', _py_script('tests/library/test_testbench_ci.py')),
            ('tests/library/test_testbench_workflow.py', _py_script('tests/library/test_testbench_workflow.py')),
            ('tests/library/test_workflow.py', _py_script('tests/library/test_workflow.py')),
            ('tests/studio/test_design_history.py', _py_script('tests/studio/test_design_history.py')),
            ('tests/studio/test_local_compilation.py', _py_script('tests/studio/test_local_compilation.py')),
            ('tests/studio/test_version_control.py', _py_script('tests/studio/test_version_control.py')),
        ])
    plan['library'] = library_steps

    # 5. AI bridge, Codex metadata, images, MCP stdio, approvals, plugin runtime.
    ai_files = sorted(
        p.relative_to(ROOT).as_posix()
        for p in (ROOT / 'tests/ai').glob('test_*.py')
        if p.name != 'test_library_testbench.py'
    )
    if quick:
        ai_selected = [
            'tests/ai/test_connection_metadata.py',
            'tests/ai/test_images.py',
            'tests/ai/test_development.py',
            'tests/ai/test_service.py',
            'tests/ai/test_library_adapter.py',
        ]
    else:
        ai_selected = ai_files
    ai_steps = [(f, _py_script(f)) for f in ai_selected]
    ai_steps.append(('tests/plugin/test_runtime.py', _py_script('tests/plugin/test_runtime.py')))
    if py_ver >= (3, 11):
        ai_steps.append(('tests/plugin/test_install.py', _py_script('tests/plugin/test_install.py')))
    if not quick:
        ai_steps.extend([
            ('tests/codex/test_geometry_selection.py', _py_script('tests/codex/test_geometry_selection.py')),
            ('tests/codex/test_workbench.py', _py_script('tests/codex/test_workbench.py')),
        ])
    plan['ai'] = ai_steps

    # 6. Frontend JavaScript unit tests (Node 22+), split by area for clear reporting.
    if has_node:
        node_bin = shutil.which('node') or 'node'
        has_real_sar = (
            (ROOT / 'projects/real-sar-20261106/circuit.scs').is_file()
            and (ROOT / 'apps/web/assets/real-sar.circuit.scs').is_file()
        )
        viewer_patterns = (
            ['tests/core.test.mjs', 'tests/viewer-mapping.test.mjs', 'tests/viewer-hierarchy.test.mjs', 'tests/viewer-vendor.test.mjs']
            if has_real_sar else ['tests/viewer-vendor.test.mjs']
        )
        if quick:
            groups = [
                ('frontend: demo/remote/library/waveforms', [
                    'tests/demo/*.test.mjs',
                    'tests/remote/pair.test.mjs',
                    'tests/remote/client.test.mjs',
                    'tests/library/*.test.mjs',
                    'tests/waveforms/mapping.test.mjs',
                    'tests/viewer-vendor.test.mjs',
                ]),
            ]
        else:
            groups = [
                ('frontend: demo & context & waveforms', ['tests/demo/*.test.mjs', 'tests/context/*.test.mjs', 'tests/waveforms/*.test.mjs']),
                ('frontend: remote & library & workflow', ['tests/remote/*.test.mjs', 'tests/library/*.test.mjs', 'tests/workflow/*.test.mjs', 'tests/native/*.test.mjs']),
                ('frontend: studio panels', ['tests/studio/*.test.mjs']),
                ('frontend: viewer & engineering', viewer_patterns),
                ('frontend: codex & ai ui', ['tests/codex/*/*.test.mjs', 'tests/codex_ui/*.test.mjs', 'tests/ai/*.test.mjs']),
            ]
        frontend_steps = []
        for label, patterns in groups:
            node_files = _collect_node_tests(patterns)
            if not has_real_sar:
                node_files = [f for f in node_files if f != 'tests/codex/schematic/data.test.mjs']
            if node_files:
                frontend_steps.append((f'{label} ({len(node_files)} files)', [node_bin, '--test', *node_files]))
        plan['frontend'] = frontend_steps
    else:
        plan['frontend'] = []

    # 7. Optional SpiceOwl-dependent integration tests (auto-enabled when spiceowl is installed).
    if include_spiceowl:
        plan['spiceowl'] = [
            ('tests/ai/test_library_testbench.py', _py_script('tests/ai/test_library_testbench.py')),
            ('tools/workbench/test_onboarding_discovery_budget.py', _py_unit('tools/workbench/test_onboarding_discovery_budget.py')),
            ('tools/workbench/test_onboarding_foundation.py', _py_unit('tools/workbench/test_onboarding_foundation.py')),
            ('tools/workbench/test_onboarding_http.py', _py_unit('tools/workbench/test_onboarding_http.py')),
            ('tools/workbench/test_spiceowl_pool.py', _py_unit('tools/workbench/test_spiceowl_pool.py')),
            ('tools/workbench/test_spiceowl_readonly.py', _py_unit('tools/workbench/test_spiceowl_readonly.py')),
        ]

    return plan


def main(argv=None):
    _configure_stdio()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--suite', help='Comma-separated suites: architecture,remote,simulation,library,ai,frontend,spiceowl')
    parser.add_argument('--quick', action='store_true', help='Run fast smoke coverage across every subsystem')
    parser.add_argument('--require-node', action='store_true', help='Fail if Node.js is not available')
    parser.add_argument('--require-ngspice', action='store_true', help='Fail if ngspice is not installed locally')
    parser.add_argument('--require-spiceowl', action='store_true', help='Run and require SpiceOwl integration tests')
    parser.add_argument('--json-report', type=Path, help='Write structured JSON report to this path')
    parser.add_argument('--list', action='store_true', help='Print planned steps without running them')
    args = parser.parse_args(argv)

    node_bin = shutil.which('node')
    ngspice_bin = local_sim.detect_local_simulator('ngspice')
    has_spiceowl = _has_module('spiceowl')

    if args.require_node and not node_bin:
        print('ERROR: --require-node set, but `node` was not found in PATH.', file=sys.stderr)
        return 2
    if args.require_ngspice and not ngspice_bin:
        print('ERROR: --require-ngspice set, but `ngspice` was not detected locally.', file=sys.stderr)
        return 2
    if args.require_spiceowl and not has_spiceowl:
        print('ERROR: --require-spiceowl set, but `spiceowl` is not installed in this Python.', file=sys.stderr)
        return 2

    include_spiceowl = has_spiceowl or args.require_spiceowl
    plan = build_plan(quick=args.quick, include_spiceowl=include_spiceowl, has_node=bool(node_bin))

    if args.suite:
        selected_suites = [s.strip() for s in args.suite.split(',') if s.strip()]
        unknown = [s for s in selected_suites if s not in plan]
        if unknown:
            print('ERROR: unknown or unavailable suite(s): ' + ', '.join(unknown), file=sys.stderr)
            return 2
    else:
        selected_suites = [name for name, steps in plan.items() if steps]

    print(
        f'CircuitGit Cross-Platform Test Runner | OS={platform.system()} ({os.name}) '
        f'| Python={platform.python_version()} | node={"yes" if node_bin else "no"} '
        f'| ngspice={"yes" if ngspice_bin else "no"} | spiceowl={"yes" if has_spiceowl else "no"}'
    )
    print('Suites:', ', '.join(selected_suites))

    if args.list:
        for suite in selected_suites:
            print(f'\n[{suite}]')
            for label, cmd in plan[suite]:
                print(f'  - {label}: {" ".join(cmd)}')
        return 0

    env = _python_env()
    results = []
    started_all = time.monotonic()
    failed = 0

    for suite in selected_suites:
        print(f'\n=== Suite: {suite} ===', flush=True)
        for label, cmd in plan[suite]:
            res = _run_step(label, cmd, env=env)
            res['suite'] = suite
            results.append(res)
            tag = 'PASS' if res['ok'] else 'FAIL'
            print(f'  [{tag}] {label} ({res["seconds"]:.2f}s)', flush=True)
            if not res['ok']:
                failed += 1
                for line in res['stderr_tail'] or res['stdout_tail']:
                    print('        ' + line, flush=True)

    total_seconds = round(time.monotonic() - started_all, 2)
    report = {
        'schema': 'circuitgit.cross-platform-test-report.v1',
        'platform': {
            'system': platform.system(),
            'release': platform.release(),
            'machine': platform.machine(),
            'os_name': os.name,
            'is_windows': platform_compat.IS_WINDOWS,
            'python': platform.python_version(),
            'node_available': bool(node_bin),
            'ngspice_available': bool(ngspice_bin),
            'spiceowl_available': has_spiceowl,
        },
        'mode': 'quick' if args.quick else 'full',
        'suites': selected_suites,
        'total_steps': len(results),
        'passed_steps': len(results) - failed,
        'failed_steps': failed,
        'seconds': total_seconds,
        'status': 'passed' if failed == 0 else 'failed',
        'steps': results,
    }

    if args.json_report:
        args.json_report.parent.mkdir(parents=True, exist_ok=True)
        args.json_report.write_text(json.dumps(report, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')

    print(
        f'\nSummary: {report["passed_steps"]}/{report["total_steps"]} passed, '
        f'{failed} failed in {total_seconds:.2f}s.'
    )
    return 0 if failed == 0 else 1


if __name__ == '__main__':
    raise SystemExit(main())
