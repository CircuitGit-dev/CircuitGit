"""Bounded configuration description and explicit Spectre save compilation.

This is an evidence index for a supported netlist subset, not a Spectre parser.
It never evaluates simulator code, opens external models, or runs a process.
"""
import ast
import copy
import hashlib
import json
import math
import posixpath
import re

SCHEMA = 'ic.sim.configuration-description.v1'
MAX_SIGNALS = 256
MAX_OCCURRENCES = 10000
MAX_NETS = 20000
MAX_TERMINALS = 50000
MAX_DEPTH = 32
MAX_BYTES = 20 * 1024 * 1024
SAVE_FILE = 'netlist/icwb-save.scs'
CONFIG_KEYS = {'description', 'parameters', 'analysis', 'simulator', 'postprocess', 'save'}
NAME = re.compile(r'[A-Za-z_][A-Za-z0-9_$]*(?:<[0-9]+>)?\Z|[0-9]+\Z')
ASSIGN = re.compile(r'([A-Za-z_]\w*)\s*=\s*("[^"\n]*"|\[[^\]\n]*\]|[^\s]+)')
RAW_OPTIONS = {'save', 'currents', 'subcktprobelvl', 'pwr', 'nestlvl', 'useterms', 'savefilter', 'saveports', 'subcktiprobes', 'useprobes'}

def sha(raw):
    return hashlib.sha256(raw).hexdigest()

def canonical_hash(value):
    return sha(json.dumps(value, sort_keys=True, separators=(',', ':')).encode())

def load_configuration(raw):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError('duplicate configuration key: ' + key)
            result[key] = value
        return result
    if len(raw) > 1024 * 1024:
        raise ValueError('configuration exceeds 1 MiB')
    conf = json.loads(raw, object_pairs_hook=unique, parse_constant=lambda x: (_ for _ in ()).throw(ValueError('non-finite JSON: '+x)))
    if not isinstance(conf, dict) or set(conf) - CONFIG_KEYS:
        raise ValueError('unsupported configuration fields: ' + ', '.join(sorted(set(conf)-CONFIG_KEYS)) if isinstance(conf, dict) else 'configuration must be an object')
    for field in ['parameters', 'analysis']:
        if field in conf and not isinstance(conf[field], dict):
            raise ValueError(field + ' must be an object')
        if field in conf and any(type(v) not in (str,int,float) for v in conf[field].values()):
            raise ValueError(field + ' values must be strings or finite numbers, not booleans/objects')
    if 'description' in conf and (not isinstance(conf['description'], str) or len(conf['description']) > 8000):
        raise ValueError('description must be at most 8000 characters')
    if 'simulator' in conf and (not isinstance(conf['simulator'], dict) or set(conf['simulator']) - {'profile', 'args', 'output_format'}):
        raise ValueError('unsupported simulator configuration fields')
    if 'save' in conf and conf['save'] is None:
        raise ValueError('save must be a structured object; omit it to inherit defaults')
    return conf

def normalized(token):
    return token.replace('\\<', '<').replace('\\>', '>')

def valid_name(token):
    return len(token) <= 160 and bool(NAME.fullmatch(normalized(token)))

def statements(raw, path):
    """Retain original physical spans for traceable display/derived-file edits."""
    text = raw.decode('utf-8')
    if '\x00' in text or len(raw) > 2 * 1024 * 1024:
        raise ValueError('unsupported or oversized netlist file: ' + path)
    lines = text.splitlines(keepends=True)
    if len(lines) > 50000:
        raise ValueError('too many netlist lines: ' + path)
    records = []
    start = 0
    while start < len(lines):
        end = start + 1
        while lines[end-1].rstrip().endswith('\\'):
            if end == len(lines):
                raise ValueError('unterminated continuation: ' + path)
            end += 1
        literal = ''.join(lines[start:end])
        logical = re.sub(r'\\\r?\n\s*', ' ', literal)
        # Quoted // is not interpreted as a comment.
        logical = re.sub(r'("[^"\n]*")|//[^\n]*', lambda m: m[1] or '', logical).strip()
        records.append({'path': path, 'line_start': start+1, 'line_end': end, 'text': logical})
        start = end
    return records

def location(record):
    return {k: record[k] for k in ['path', 'line_start', 'line_end']}

def scan(files, entry):
    if len(files) > 300 or sum(len(b) for b in files.values()) > MAX_BYTES:
        raise ValueError('configuration input closure exceeds limits')
    visited, order, limitations, external = set(), [], [], []
    records = {}
    def walk(path, stack):
        if path in stack or len(stack) >= MAX_DEPTH:
            raise ValueError('cyclic or excessive local include hierarchy')
        if path in visited:
            raise ValueError('repeated local include is ambiguous for configuration: ' + path)
        if path not in files:
            raise ValueError('local include missing from staged files: ' + path)
        visited.add(path)
        records[path] = statements(files[path], path)
        for record in records[path]:
            line = record['text']
            match = re.fullmatch(r'include\s+"([^"\n]+)"(?:\s+section=\S+)?', line, re.I)
            if match:
                target = match[1]
                if target.startswith('@EXTERNAL_') and target.endswith('@'):
                    external.append({**location(record), 'reference': target})
                    continue
                if target.startswith('/') or '\\' in target:
                    limitations.append({**location(record), 'reason': 'non-local include is not indexed', 'statement': line})
                    continue
                resolved = posixpath.normpath(posixpath.join(posixpath.dirname(path), target))
                if resolved.startswith('../') or resolved not in files:
                    raise ValueError('include escapes staged closure: ' + target)
                walk(resolved, stack+[path])
            else:
                order.append(record)
    walk(entry, [])
    definitions = {}
    top = {'name': '(top)', 'ports': [], 'instances': [], 'nets': {}}
    scope = top
    saves, options = [], []
    for record in order:
        line = record['text']
        if not line or line.startswith(('*', '//')):
            continue
        if line.lower().startswith('simulator '):
            if not re.fullmatch(r'simulator\s+lang=spectre', line, re.I):
                limitations.append({**location(record), 'reason':'non-Spectre language', 'statement':line})
            continue
        if re.match(r'subckt\s', line, re.I):
            parts = line.split()
            if scope is not top or not 2 <= len(parts) <= 258 or not valid_name(parts[1]) or parts[1] in definitions or any(not valid_name(p) for p in parts[2:]):
                raise ValueError('ambiguous/unsupported subcircuit declaration')
            scope = {'name':parts[1], 'ports':parts[2:], 'instances':[], 'nets':{p:record for p in parts[2:]}}
            definitions[parts[1]] = scope
            continue
        if re.match(r'ends(?:\s|$)', line, re.I):
            if scope is top or (len(line.split()) > 1 and line.split()[1] != scope['name']):
                raise ValueError('mismatched subcircuit end')
            scope = top
            continue
        if re.match(r'save(?:\s|$)', line, re.I):
            saves.append({**record, 'scope': scope['name'], 'tokens': line.split()[1:]})
            continue
        if re.match(r'\S+\s+options(?:\s|$)', line, re.I):
            values = dict(ASSIGN.findall(line))
            relevant = {k:v for k,v in values.items() if k in RAW_OPTIONS}
            if relevant:
                options.append({**record, 'scope': scope['name'], 'values': relevant})
            continue
        instance = re.fullmatch(r'(\S+)\s*\(([^)]*)\)\s+(\S+)(?:\s+.*)?', line)
        if instance:
            name, nodes, master = instance[1], instance[2].split(), instance[3]
            if not valid_name(name) or any(not valid_name(n) for n in nodes) or not 1 <= len(nodes) <= 256:
                limitations.append({**location(record), 'reason':'unsupported instance/net spelling', 'statement':line})
                continue
            if any(i['name'] == name for i in scope['instances']):
                raise ValueError('duplicate instance in netlist scope')
            scope['instances'].append({'name': name, 'nodes': nodes, 'master': master, 'source':location(record)})
            for node in nodes:
                scope['nets'].setdefault(node, record)
        elif re.search(r'\b(?:if|else|for|alter|altergroup)\b', line) or '(' in line and not re.match(r'(parameters|tran\s+tran)\b', line):
            limitations.append({**location(record), 'reason':'unsupported structural statement', 'statement':line})
    if scope is not top:
        raise ValueError('unterminated subcircuit')
    nets, instances = {}, {}
    terminal_count=0
    def descend(block, prefix, ancestry):
        nonlocal terminal_count
        if block['name'] in ancestry or len(ancestry) > MAX_DEPTH:
            raise ValueError('recursive or excessive occurrence hierarchy')
        for node, record in block['nets'].items():
            if normalized(node) == '0':
                continue
            token = prefix + node
            key = normalized(token)
            if len(key)>240:raise ValueError('net occurrence path exceeds limit')
            if key in nets and nets[key]['token'] != token:
                raise ValueError('ambiguous escaped net identity')
            nets[key] = {'path':key, 'token':token, 'source':location(record)}
            if len(nets) > MAX_NETS:
                raise ValueError('net catalog exceeds limit')
        for inst in block['instances']:
            token = prefix+inst['name']
            key = normalized(token)
            if len(key)>240:raise ValueError('instance occurrence path exceeds limit')
            if key in instances:
                raise ValueError('ambiguous occurrence identity')
            child = definitions.get(inst['master'])
            if child and len(child['ports']) != len(inst['nodes']):
                raise ValueError('subcircuit connection count mismatch: '+key)
            # Numeric positions bind to the actual node tuple. Only the known
            # two-terminal independent sources additionally expose p/n aliases.
            terminals = [{'id':str(i+1), 'label':normalized(child['ports'][i]) if child else str(i+1), 'net':normalized(prefix+n)} for i,n in enumerate(inst['nodes'])]
            if inst['master'] in {'vsource','isource'} and len(inst['nodes']) == 2:
                terminals += [{'id':alias, 'label':alias, 'net':normalized(prefix+n)} for alias,n in zip(['p','n'],inst['nodes'])]
            terminal_count+=len(terminals)
            if terminal_count>MAX_TERMINALS:raise ValueError('terminal catalog exceeds limit')
            instances[key] = {'path':key, 'token':token, 'master':inst['master'], 'terminals':terminals, 'source':inst['source'], 'definition':'local' if child else 'primitive_or_external_leaf'}
            if len(instances) > MAX_OCCURRENCES:
                raise ValueError('instance catalog exceeds limit')
            if child:
                descend(child,token+'.',ancestry+[block['name']])
    descend(top,'',[])
    return {'records':records,'saves':saves,'options':options,'nets':nets,'instances':instances,'limitations':limitations,'external':external,'local_files':sorted(visited)}

def resolve_signal(item, index):
    if not isinstance(item, dict):
        raise ValueError('save signal must be a typed object')
    if item.get('kind') == 'voltage' and set(item) == {'kind','path'}:
        path = item['path']
        if not isinstance(path,str) or path not in index['nets']:
            raise ValueError('save voltage is not a verified net: '+str(path))
        target = index['nets'][path]
        return {**item, 'spectre':target['token'], 'source':target['source']}
    if item.get('kind') == 'current' and set(item) == {'kind','instance','terminal'}:
        path, terminal = item['instance'], item['terminal']
        if not isinstance(path,str) or not isinstance(terminal,str) or path not in index['instances']:
            raise ValueError('save current needs a verified instance and explicit terminal')
        target = index['instances'][path]
        if terminal not in {t['id'] for t in target['terminals']}:
            raise ValueError('save current terminal is not in the instance connection tuple')
        position = {'p':'1','n':'2'}.get(terminal,terminal)
        return {**item, 'spectre':target['token']+':'+terminal, 'identity':path+':'+position, 'source':target['source']}
    raise ValueError('unknown save signal kind or fields')

def token_signal(token, index):
    normalized_token = normalized(token)
    if ':' in normalized_token:
        inst,terminal = normalized_token.rsplit(':',1)
        item = {'kind':'current','instance':inst,'terminal':terminal}
    else:
        item = {'kind':'voltage','path':normalized_token}
    try:
        return resolve_signal(item,index)
    except ValueError:
        return None

def save_description(index):
    effective, unsupported = {}, []
    for record in index['saves']:
        if record['scope'] != '(top)':
            unsupported.append({**location(record),'statement':record['text'],'reason':'subcircuit-local save cannot be replaced'})
            continue
        for token in record['tokens']:
            found = token_signal(token,index)
            if found is None:
                unsupported.append({**location(record),'statement':record['text'],'token':token,'reason':'not an indexed literal save target'})
                continue
            key = found['spectre']
            effective.setdefault(key,{**found,'origins':[]})['origins'].append(location(record))
    policy = {}
    for record in index['options']:
        policy.update(record['values'])
    return {'signals':list(effective.values()), 'directives':[{**location(r),'scope':r['scope'],'statement':r['text']} for r in index['saves']],
            'options':[{**location(r),'values':r['values'],'statement':r['text']} for r in index['options']], 'policy':policy,
            'unresolved_directives':unsupported, 'external_includes':index['external'], 'limitations':index['limitations'],
            'undeclared_policy_fields':sorted(RAW_OPTIONS-set(policy)),
            'implicit_defaults':'Undeclared options retain simulator defaults; explicit signal list does not enumerate every possible raw quantity.',
            'scope':'explicit local directives; external model contents and simulator implicit outputs are not enumerated',
            'replace_supported':not unsupported and not index['limitations'] and all(r['scope']=='(top)' and set(r['values'])=={'save'} and r['values']['save']=='selected' for r in index['options'])}

def apply_save(files,entry,spec):
    index = scan(files,entry)
    inherited = save_description(index)
    mode = 'inherit'
    selected = []
    result = dict(files)
    if spec is not None:
        if not isinstance(spec,dict) or set(spec) != {'mode','signals'} or spec['mode'] not in {'append','replace'}:
            raise ValueError('save requires mode append/replace and explicit signals')
        mode = spec['mode']
        signals = spec['signals']
        if not isinstance(signals,list) or not 1 <= len(signals) <= MAX_SIGNALS:
            raise ValueError('save requires 1..256 explicit signals')
        if index['limitations']:
            raise ValueError('save editing blocked by unsupported netlist structure; inherited defaults remain readable')
        selected = [resolve_signal(s,index) for s in signals]
        tokens = [s.get('identity',s['spectre']) for s in selected]
        if len(set(tokens)) != len(tokens):
            raise ValueError('duplicate save target')
        if SAVE_FILE in result:
            raise ValueError('reserved derived save file already exists')
        if mode == 'replace':
            if not inherited['replace_supported']:
                raise ValueError('replace cannot safely override these inherited save directives/options')
            if not any(s['kind']=='voltage' for s in selected):
                raise ValueError('replace requires at least one explicit voltage to avoid implicit voltage-save fallback')
            removals = {}
            for record in index['saves']:
                removals.setdefault(record['path'],set()).update(range(record['line_start']-1,record['line_end']))
            for path,lines in removals.items():
                result[path] = ''.join(line for i,line in enumerate(result[path].decode().splitlines(keepends=True)) if i not in lines).encode()
        policy = 'icwbSaveOptions options save=selected\n' if mode == 'replace' else ''
        result[SAVE_FILE] = ('simulator lang=spectre\n// Derived from bounded workbench save configuration.\n'+policy+'\n'.join('save '+s['spectre'] for s in selected)+'\n').encode()
        relative = posixpath.relpath(SAVE_FILE,posixpath.dirname(entry))
        result[entry] = result[entry].rstrip()+('\ninclude "'+relative+'"\n').encode()
    current = save_description(scan(result,entry)) if spec is not None else inherited
    return result, {'mode':mode,'requested':copy.deepcopy(spec),'selected':selected,'inherited':inherited,'effective':current,'generated_file':SAVE_FILE if spec is not None else None}, index

def numeric(expression,parameters):
    """Optional arithmetic display only; simulator source expression stays authoritative."""
    suffix={'T':1e12,'G':1e9,'M':1e6,'K':1e3,'k':1e3,'m':1e-3,'u':1e-6,'n':1e-9,'p':1e-12,'f':1e-15,'a':1e-18}
    def number(text,seen):
        if len(seen)>32 or len(text)>240:return None
        text=re.sub(r'(?<![\w.])((?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)([TGMKkmunpfa])\b',lambda m:'('+m[1]+'*'+str(suffix[m[2]])+')',text)
        try:tree=ast.parse(text,mode='eval')
        except (SyntaxError,ValueError):return None
        def val(n,depth=0):
            if depth>32:raise ValueError('depth')
            if isinstance(n,ast.Constant) and type(n.value) in (int,float):return float(n.value)
            if isinstance(n,ast.Name) and n.id in parameters and n.id not in seen:
                out=number(str(parameters[n.id]),seen|{n.id})
                if out is None:raise ValueError('unresolved')
                return out
            if isinstance(n,ast.UnaryOp) and isinstance(n.op,(ast.UAdd,ast.USub)):
                return val(n.operand,depth+1)*(1 if isinstance(n.op,ast.UAdd) else -1)
            if isinstance(n,ast.BinOp) and isinstance(n.op,(ast.Add,ast.Sub,ast.Mult,ast.Div)):
                a,b=val(n.left,depth+1),val(n.right,depth+1)
                return a+b if isinstance(n.op,ast.Add) else a-b if isinstance(n.op,ast.Sub) else a*b if isinstance(n.op,ast.Mult) else a/b
            raise ValueError('unsupported arithmetic')
        try:
            result=val(tree.body)
            return result if math.isfinite(result) else None
        except (ValueError,ZeroDivisionError,OverflowError):return None
    return number(str(expression),set())

def settings(files,entry,save_info,simulator,postprocess):
    rows=statements(files[entry],entry)
    parameters=[r for r in rows if r['text'].startswith('parameters ')]
    analyses=[r for r in rows if re.match(r'tran\s+tran\b',r['text'])]
    p=dict(ASSIGN.findall(parameters[0]['text'])) if len(parameters)==1 else {}
    a=dict(ASSIGN.findall(analyses[0]['text'])) if len(analyses)==1 else {}
    explicit = {normalized(s['spectre']) for s in save_info['effective']['signals']}
    unconfirmed = [s for s in (postprocess or {}).get('signals',[]) if normalized(s['name']) not in explicit]
    if save_info['mode']=='replace' and unconfirmed:
        raise ValueError('postprocess signals are not in the replacement raw-save list: '+', '.join(s['name'] for s in unconfirmed))
    return {'parameters':p,'parameter_values_si':{k:numeric(v,p) for k,v in p.items()},
        'parameter_statements':[{**location(r),'statement':r['text']} for r in parameters],
        'tran':{'values':a,'values_si':{k:numeric(v,p) for k,v in a.items()},'statements':[{**location(r),'statement':r['text']} for r in analyses]},
        'simulator':simulator,'raw_save':save_info,'postprocess':postprocess,
        'postprocess_role':'OCEAN extraction from saved raw results; does not choose all simulator raw saves',
        'postprocess_unconfirmed_in_explicit_save':unconfirmed,
        'compiled_files_sha256':{k:sha(v) for k,v in sorted(files.items())},
        'compiled_inputs_sha256':canonical_hash({k:sha(v) for k,v in sorted(files.items())})}

def descriptor(project,configuration,commit,raw,bundle,files,sources):
    index=scan(files,bundle['entrypoint'])
    return {'schema':SCHEMA,'project_id':project['id'],'configuration':configuration['id'],'source_commit':commit,
        'configuration_path':configuration['configuration_path'],'configuration_sha256':sha(raw),'configuration_text':raw.decode(),
        'configuration_json':load_configuration(raw),'source_hashes':sources,'template_path':configuration['bundle_template'],
        'template_reference':bundle['configuration']['template_reference'],'effective':bundle['configuration']['effective'],
        'catalog':{'nets':list(index['nets'].values()),'instances':list(index['instances'].values()),'limitations':index['limitations'],
            'external_includes':index['external'],'scope':'reachable instances and nets in committed local input closure; external internals excluded'},
        'editable_analysis_fields':['stop','maxstep','errpreset','method','maxiters'],
        'save_limits':{'max_signals':MAX_SIGNALS,'modes':['append','replace'],'replace_supported':bundle['configuration']['effective']['raw_save']['inherited']['replace_supported']}}
