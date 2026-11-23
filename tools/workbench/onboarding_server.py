"""Start a deliberately fresh simulation-only gateway and browser companion."""
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import signal
import stat
import threading
import webbrowser

from onboarding_runtime import create_onboarding_config
from runner import atomic


@contextlib.contextmanager
def onboarding_state_lock(state):
    """One launcher owns a store for its lifetime, independently of TCP ports."""
    state=Path(state).expanduser().absolute()
    if state.is_symlink():raise ValueError('Select a regular onboarding state directory')
    state.parent.mkdir(parents=True,exist_ok=True)
    # Keep the lock outside the store so a genuinely new store stays empty.
    # Keep its inode after release: unlinking it could let a waiting process
    # and a new launcher lock two different files for the same state.
    name='.onboarding-'+hashlib.sha256(os.fsencode(str(state.resolve()))).hexdigest()+'.lock'
    try:fd=os.open(state.parent/name,os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
    except OSError:raise ValueError('Unable to open the onboarding state lock') from None
    try:
        info=os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1:
            raise ValueError('Onboarding state lock must be a regular local file')
        os.fchmod(fd,0o600)
        try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError('This onboarding state is already in use by another launcher') from None
        try:yield
        finally:fcntl.flock(fd,fcntl.LOCK_UN)
    finally:os.close(fd)


def serve_onboarding(state,*,root,node_port,gateway_port,allow_origins=(),resume=False,no_browser=False):
    with onboarding_state_lock(state):
        return _serve_onboarding(state,root=root,node_port=node_port,gateway_port=gateway_port,
            allow_origins=allow_origins,resume=resume,no_browser=no_browser)


def _serve_onboarding(state,*,root,node_port,gateway_port,allow_origins,resume,no_browser):
    import server as engineering
    from remote_node import Server,Handler,Node,node_identity
    # Bind first. Never stop, reuse or replace an unrelated helper.
    browser=Server(('127.0.0.1',node_port),Handler)
    gateway=None;app=None;gateway_started=False;thread=None;previous_sigterm=None
    try:
        gateway=engineering.Server(('127.0.0.1',gateway_port),engineering.Handler)
        cfg=create_onboarding_config(state,resume=resume)
        state=Path(state).expanduser().absolute()
        app=engineering.Application(cfg,Path(root)/'web');gateway.app=app
        node_state=state/'node';node_state.mkdir(mode=0o700,exist_ok=True)
        identity=node_state/'node-id'
        if identity.exists() and identity.read_text()!=cfg['onboarding']['connection_id']:
            raise ValueError('Onboarding node and store identities differ')
        if not identity.exists():
            identity.write_text(cfg['onboarding']['connection_id']);identity.chmod(0o600)
        token,node_id,_=node_identity(node_state)
        gateway_url='http://127.0.0.1:'+str(gateway.server_port)
        node_url='http://127.0.0.1:'+str(browser.server_port)
        node=Node(None,token,['https://circuitgit-dev.github.io',gateway_url,*allow_origins],
                  node_id,node_url,'仿真环境接入')
        node.onboarding=app.onboarding;node.onboarding_review_base=gateway_url;browser.node=node
        thread=threading.Thread(target=gateway.serve_forever,daemon=True);thread.start();gateway_started=True
        atomic(state/'active-process.json',{'connection_id':node_id,'gateway_url':gateway_url,
            'node_url':node_url,'source_commit':None,'chat_enabled':False})
        print(json.dumps({'mode':'fresh-simulation-onboarding','connection_id':node_id,
            'gateway_url':gateway_url,'node_url':node_url,'source_commit':None,
            'chat_enabled':False,'ssh_started':False}),flush=True)
        if not no_browser:webbrowser.open(gateway_url)
        def stop(signum,frame):raise KeyboardInterrupt
        previous_sigterm=signal.signal(signal.SIGTERM,stop)
        try:browser.serve_forever()
        except KeyboardInterrupt:pass
    finally:
        try:
            if gateway_started:
                gateway.shutdown()
                thread.join(timeout=5)
        finally:
            browser.server_close()
            if gateway:gateway.server_close()
            if previous_sigterm is not None:signal.signal(signal.SIGTERM,previous_sigterm)
            if app:
                try:app.onboarding.close()
                finally:
                    try:app.simulation.close()
                    finally:app.pool.shutdown(wait=False)
