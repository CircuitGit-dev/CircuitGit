"""Optional, bounded live GET-only acceptance for new view adapters. No model/solver/write calls."""
import json,sys,tempfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
sys.path[:0]=[str(ROOT/'apps/codex'),str(ROOT/'modules/gateway_client')]
from icwb.service import Service,Gateway
from icwb.views import ViewService

class ReadOnlyGateway(Gateway):
    def request(self,path,body=None):
        if body is not None:raise AssertionError('Live acceptance forbids POST')
        return super().request(path)

def main():
    with tempfile.TemporaryDirectory(prefix='ic-mcp-read-') as tmp:
        service=Service({'gateway_url':'http://127.0.0.1:8766','state_dir':tmp});service.gateway=ReadOnlyGateway('http://127.0.0.1:8766')
        views=ViewService(service);registry=service.call('projects',{});jobs=service.gateway.request('/api/jobs')['jobs'];report={'kind':'new MCP view adapters, GET-only existing8766','production_posts':0,'model_calls':0,'runs':[]}
        workspace=None;curves=0
        native_only='--native-only' in sys.argv
        for job in ([] if native_only else jobs):
            if curves>=6:break
            pid=job.get('associated_project_id') or job.get('project_id');rid=job.get('run_id') or job.get('job_id')
            if pid not in {p['id'] for p in registry['projects']}:continue
            args={'project_id':pid,'run_id':rid}
            if workspace:args['workspace_id']=workspace
            view,_=views.call('ic_waveforms_open',args);workspace=view['workspace_id']
            ref={k:view[k] for k in ('view_id','workspace_id','revision')}
            _,private=views.call('ic_view_data',{**ref,'query':{'kind':'signals'}});catalog=private['payload'];rows=[]
            for signal in catalog['signals']:
                if signal.get('status')!='available' or curves>=6:continue
                _,payload=views.call('ic_view_data',{**ref,'query':{'kind':'waveform','signal_id':signal['id'],'limit':16}})
                value=payload['payload'];rows.append({'signal_id':signal['id'],'label':signal.get('label'),'data_keys':sorted(value),'identity_source_commit':catalog.get('source_commit')});curves+=1
            report['runs'].append({'run_id':rid,'project_id':pid,'catalog_count':len(catalog['signals']),'read_curves':rows})
        project=next(p for p in registry['projects'] if p.get('configurations'))
        view,_=views.call('ic_simulation_open',{'project_id':project['id'],'configuration':project['configurations'][0]['id'],'workspace_id':workspace} if workspace else {'project_id':project['id'],'configuration':project['configurations'][0]['id']})
        _,config=views.call('ic_view_data',{**{k:view[k] for k in ('view_id','workspace_id','revision')},'query':{'kind':'configuration'}})
        report['configuration']={'project_id':project['id'],'configuration':view['identity']['configuration'],'source_commit':view['identity']['source_commit'],'has_configuration_text':isinstance(config['payload'].get('configuration_text'),str)}
        schematic,_=views.call('ic_schematic_open',{'project_id':project['id'],'workspace_id':view['workspace_id']})
        _,data=views.call('ic_view_data',{**{k:schematic[k] for k in ('view_id','workspace_id','revision')},'query':{'kind':'schematic'}})
        geometry=data['payload'].get('geometry',{});report['schematic']={'project_id':project['id'],'state':geometry.get('state'),'native_ready':geometry.get('native_ready')}
        if geometry.get('available'):
            ref={k:schematic[k] for k in ('view_id','workspace_id','revision')}
            _,manifest=views.call('ic_view_data',{**ref,'query':{'kind':'geometry_manifest','entry':geometry['root_cell']}})
            first=manifest['payload']['files'][0]
            _,chunk=views.call('ic_view_data',{**ref,'query':{'kind':'geometry_file','path':first['path'],'limit':1024}})
            report['schematic'].update(manifest_file_count=len(manifest['payload']['files']),first_file=first['path'],first_file_sha256=chunk['payload']['sha256'],first_chunk_bytes=min(1024,chunk['payload']['total_bytes']))
        report['curves_read']=curves;report['status']='passed' if (curves==6 or native_only and report['schematic'].get('first_file_sha256')) and report['configuration']['has_configuration_text'] else 'partial'
        report['native_only']=native_only
        print(json.dumps(report,ensure_ascii=False,indent=2))
        return 0 if report['status']=='passed' else 1
if __name__=='__main__':raise SystemExit(main())
