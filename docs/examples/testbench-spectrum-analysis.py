"""Reference analysis.py for a reviewed spec_analyze recipe.

Run manually in the pinned SpiceOwl environment against a collected full CSV.
CircuitGit CI invokes the same named API through OnboardingAnalysis; it never
executes this file. The CI adapter additionally checks run/archive/source IDs.
"""
import argparse
import csv
import hashlib
import io
import json
from pathlib import Path


def analyze(csv_bytes, expected_csv_sha256, manifest, time_column):
    from spiceowl.adctools import spec_analyze

    if hashlib.sha256(csv_bytes).hexdigest() != expected_csv_sha256:
        raise ValueError('Original full-resolution CSV digest differs')
    recipe = manifest['postprocess']
    if recipe['operation'] != 'spec_analyze':
        raise ValueError('This reference script supports the spec_analyze recipe')
    selector = recipe['inputs']['samples']
    if not isinstance(selector, dict) or set(selector) - {'name', 'analysis', 'quantity', 'unit'}:
        raise ValueError('Provide the exact reviewed sample signal name')
    if recipe['parameters'].get('backend') not in ('spiceowl', 'adctoolbox'):
        raise ValueError('An explicit reviewed numerical backend is required')
    rows = list(csv.DictReader(io.StringIO(csv_bytes.decode('utf-8'))))
    if not rows or time_column not in rows[0] or selector['name'] not in rows[0]:
        raise ValueError('The declared time/signal column is absent from this CSV')
    return spec_analyze(samples=[float(row[selector['name']]) for row in rows],
                        time_s=[float(row[time_column]) for row in rows], **recipe['parameters'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--csv', type=Path, required=True)
    parser.add_argument('--csv-sha256', required=True)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--time-column', required=True)
    args = parser.parse_args()
    value = json.loads(args.manifest.read_text())
    manifest = value['agent_manifest'] if value.get('schema') == 'ic.testbench_ci.v1' else value
    result = analyze(args.csv.read_bytes(), args.csv_sha256, manifest, args.time_column)
    # Numerical result only; whole-run CI binding and criterion evaluation stay
    # in the separately persisted Testbench CI adapter.
    print(json.dumps(result, indent=2, allow_nan=False))


if __name__ == '__main__':
    main()
