#!/usr/bin/env python3
"""Bounded comparison for Cadence Spectre design netlists, not a simulator.

Preserves ordered terminals/model/parameter tokens. Ignores comment lines,
whitespace, statement order and Cadence bus escaping. Checks name collisions.
Does not establish equality of analyses, PDK/model files, compiled AHDL or PSF.
"""
import argparse, hashlib, json, re
from pathlib import Path

BLOCK=re.compile(r'^subckt\s+(\S+)[^\n]*\n.*?^ends[^\n]*',re.M|re.S)

def canonical(text):
    text=re.sub(r'\\\n\s*',' ',text)
    names=set(re.findall(r'[^\s()]+',text))
    buses={x:re.sub(r'\\<(\d+)\\>',r'_\1',x) for x in names if '\\<' in x}
    if len(set(buses.values())) != len(buses) or any(v in names for v in buses.values()):
        raise ValueError('Bus normalization could merge distinct names')
    text=re.sub(r'\\<(\d+)\\>',r'_\1',text)
    text='\n'.join(' '.join(x.split()) for x in text.splitlines()
                   if x.strip() and not x.strip().startswith('//'))
    data={}
    for m in BLOCK.finditer(text):
        if m[1] in data:raise ValueError('Duplicate subcircuit '+m[1])
        data[m[1]]='\n'.join(sorted(m[0].splitlines()))
    remainder=BLOCK.sub('',text)
    data['__top_instances__']='\n'.join(sorted(x for x in remainder.splitlines()
                                             if re.match(r'^\S+ \(',x)))
    return data

def compare(a,b):
    ac,bc=canonical(a.read_text()),canonical(b.read_text())
    rows=[]
    for name in sorted(ac.keys()|bc.keys()):
        row={'cell':name,'equal':ac.get(name)==bc.get(name)}
        for key,d in [('historical',ac),('restored',bc)]:
            row[key+'_semantic_sha256']=hashlib.sha256(d[name].encode()).hexdigest() if name in d else None
        rows.append(row)
    return {'schema':'ic.design.netlist-comparison.v1','historical_sha256':hashlib.sha256(a.read_bytes()).hexdigest(),
            'restored_sha256':hashlib.sha256(b.read_bytes()).hexdigest(),'all_equal':all(x['equal'] for x in rows),
            'subcircuits':len(ac)-1,'includes_top_instances':True,'rows':rows,
            'ignored':['comment-only lines','whitespace and continuations','statement order',
                       'escaped bus name <n> versus _n (collision checked)'],
            'compared':['ordered ports and terminals','instance names','model names','parameter tokens'],
            'not_compared':['analysis settings','PDK/model bodies outside this netlist','Verilog-A content','waveforms']}

def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('historical',type=Path);ap.add_argument('restored',type=Path);ap.add_argument('--out',type=Path)
    a=ap.parse_args();r=compare(a.historical,a.restored)
    t=json.dumps(r,indent=2)+'\n'
    if a.out:a.out.parent.mkdir(parents=True,exist_ok=True);a.out.write_text(t)
    print(json.dumps({'all_equal':r['all_equal'],'subcircuits':r['subcircuits'],'top_instances_compared':True}))
    raise SystemExit(0 if r['all_equal'] else 1)

if __name__=='__main__':main()
