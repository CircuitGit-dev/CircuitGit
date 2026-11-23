#!/usr/bin/env python3
"""Copy explicitly pinned sanitized simulation candidates, without registering or executing them."""
import argparse
import json
from pathlib import Path
import re
from import_adc import ROOT, PRIVATE, EXTERNAL_DEF, relative, digest, write

PLAN = Path(__file__).with_name('simulation-import-plan.json')
MODEL_CARD = re.compile(r'^\s*(?:model|\.model|library|section)\s', re.M | re.I)
ALIAS = re.compile(r'@EXTERNAL_([A-Z][A-Z0-9_]*)@')


def audit_candidate(candidate, data):
    for name, raw in data.items():
        text = raw.decode('utf-8')
        if PRIVATE.search(text) or MODEL_CARD.search(text) or EXTERNAL_DEF.search(text):
            raise ValueError('Private/model implementation in ' + name)
        if Path(name).suffix not in {'.json', '.scs', '.va'}:
            raise ValueError('Unsupported simulation candidate member')
    if candidate['kind'] == 'configuration-audit':
        if set(data) != {'configuration.json', 'audit.json'}:
            raise ValueError('Unreviewed files in configuration-only candidate')
        if json.loads(data['audit.json'])['simulation_executed'] is not False:
            raise ValueError('Audit must not claim a new simulation')
        return
    bundle = json.loads(data['bundle.json'])
    if bundle['reviewed_for_distribution'] is not False:
        raise ValueError('Candidate must retain inactive review state')
    if json.loads(data['provenance.json'])['validation']['simulation_executed'] is not False:
        raise ValueError('Candidate must not claim a new simulation')
    aliases = {r['alias']: r['sha256'] for r in bundle['external_dependencies']}
    if set(aliases) != {'PDK_MAIN', 'PDK_TRANS_ULVT_PCELL', 'STDCELL_SVT_LVT', 'ULVT_ND2D0'}:
        raise ValueError('Unexpected external model set')
    if any(not re.fullmatch('[0-9a-f]{64}', h) for h in aliases.values()):
        raise ValueError('Missing external dependency pin')
    electrical = {r['source'] for r in bundle['files']}
    if set(data) != electrical | {'configuration.json', 'bundle.json', 'provenance.json'}:
        raise ValueError('Unreviewed simulation candidate member')
    for row in bundle['files']:
        relative(row['source']);relative(row['destination'])
        if row['source'] != row['destination'] or digest(data[row['source']]) != row['sha256']:
            raise ValueError('Candidate electrical pin mismatch')
    observed = set()
    for name in electrical:
        text = data[name].decode('utf-8')
        for include in re.findall(r'^\s*(?:include|ahdl_include)\s+"([^"\n]+)"', text, re.M):
            alias = ALIAS.fullmatch(include)
            if alias:
                if alias.group(1) not in aliases:
                    raise ValueError('Unbound external dependency')
                observed.add(alias.group(1))
            elif (Path(name).parent / relative(include)).as_posix() not in electrical:
                raise ValueError('Missing relative electrical include')
        for include in re.findall(r'^\s*`include\s+"([^"\n]+)"', text, re.M):
            if include not in {'constants.vams', 'disciplines.vams'}:
                raise ValueError('Unexpected Verilog-A system include')
    if observed != set(aliases):
        raise ValueError('External alias set differs from declared pins')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--candidate-root', type=Path, required=True)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    plan = json.loads(PLAN.read_text())
    prepared = []
    for c in plan['candidates']:
        data = {}
        for name, pin in c['files'].items():
            path = args.candidate_root / relative(c['source']) / relative(name)
            if path.is_symlink() or not path.resolve().is_relative_to(args.candidate_root.resolve()):
                raise ValueError('Candidate source outside reviewed root')
            raw = path.read_bytes()
            if digest(raw) != pin['sha256'] or len(raw) != pin['bytes']:
                raise ValueError('Candidate pin changed: ' + c['source'] + '/' + name)
            data[name] = raw
        audit_candidate(c, data)
        prepared.append((c, data))
    # Audit every candidate before changing any public output.
    for c, data in prepared:
        for name, raw in data.items():
            write(ROOT / relative(c['destination']) / relative(name), raw, args.check)
    for doc in plan['documents']:
        write(ROOT / relative(doc['path']), doc['text'].encode(), args.check)
    print(json.dumps({'candidates': len(prepared), 'files': sum(len(d) for _, d in prepared),
                      'registered_runtime_projects': 0, 'simulation_calls': 0,
                      'status': 'verified' if args.check else 'imported'}))


if __name__ == '__main__':
    main()
