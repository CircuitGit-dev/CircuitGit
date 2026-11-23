// Build a pinned, local upstream RNL Viewer. No external CDN or runtime upload.
import {cpSync,mkdirSync,readFileSync,writeFileSync,readdirSync,statSync,existsSync} from 'node:fs';
import {resolve,join,relative} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
const [upstream,core,out,bridge]=process.argv.slice(2).map(x=>resolve(x));
if(!bridge)throw Error('Usage: node build-viewer.mjs UPSTREAM CORE OUT BRIDGE');
const pinned='a240fe6bd952a28d0b7497c5c394b6c04d1f6d9c';
const commit=execFileSync('git',['rev-parse','HEAD'],{cwd:upstream,encoding:'utf8'}).trim();
if(commit!==pinned)throw Error('Upstream commit differs from reviewed source');
if(existsSync(out))throw Error('Output must be new');
mkdirSync(out,{recursive:true});
cpSync(join(upstream,'apps/viewer-ui'),out,{recursive:true,filter:p=>!['README.md','package.json','desktop.js'].includes(p.split('/').pop())});
cpSync(core,join(out,'core'),{recursive:true});
const {writeLocales}=await import(pathToFileURL(join(upstream,'scripts/i18n/viewer-locales.mjs')));
writeLocales(upstream,join(out,'locales'));
const {publishLibrary}=await import(pathToFileURL(join(upstream,'apps/web/library.mjs')));
publishLibrary(join(upstream,'libraries'),join(out,'libraries'));
mkdirSync(join(out,'fonts'),{recursive:true});
cpSync(join(upstream,'LICENSES/OFL-1.1.txt'),join(out,'fonts/OFL.txt'));
writeFileSync(join(out,'fonts/fonts.css'),'/* System font fallback; upstream Noto metrics are OFL-1.1. */\n');
writeFileSync(join(out,'about.json'),JSON.stringify({version:'0.5.1',coreVersion:'0.5.3',commit:pinned,adapter:'ic-selection-v1'})+'\n');
writeFileSync(join(out,'public-packages.json'),JSON.stringify({url:'./public-packages/catalog.json'})+'\n');
mkdirSync(join(out,'public-packages'),{recursive:true});writeFileSync(join(out,'public-packages/catalog.json'),'{}\n');
cpSync(bridge,join(out,'ic-selection-bridge.js'));
const index=join(out,'index.html');let inline=0;
let html=readFileSync(index,'utf8').replace(/<script>([\s\S]*?)<\/script>/g,(_,body)=>{
  const file=`inline-startup-${++inline}.js`;writeFileSync(join(out,file),body);return `<script src="${file}"></script>`;
});
html=html.replace('<title>RNL Viewer</title>', '<title>RNL Viewer</title>\n<script src="../../studio/route.js"></script>');
html=html.replace(/<script src="inline-startup-[12]\.js"><\/script>\s*/g,'').replace(/<script type="module" src="(?:startup|main)\.js"><\/script>\s*/g,'');
writeFileSync(index,html.replace('</body>','<script type="module" src="../../studio/viewer-entry.js"></script>\n</body>'));
// Resources resolve against the renderer, even when CircuitGit owns the document URL.
const webShell=join(out,'shells/web.js');
writeFileSync(webShell,readFileSync(webShell,'utf8').replace('new URL("libraries/", location.href)','new URL("../libraries/", import.meta.url)').replace('new URL(config.ok ? (await config.json()).url : DEFAULT_CATALOG, location.href)','new URL(config.ok ? (await config.json()).url : DEFAULT_CATALOG, new URL("../", import.meta.url))'));

const windowSession=join(out,'window-session.js');
writeFileSync(windowSession,readFileSync(windowSession,'utf8').replace('  const url = new URL(location.href);\n  url.searchParams.delete("url");', `  const url = new URL(location.href);
  // A detached schematic owns its own document/session, not a second Studio project load.
  if (document.body.classList.contains('workbench-entry')) {
    url.pathname = new URL('./index.html', import.meta.url).pathname;
    for (const key of ['studio', 'demo', 'layout']) url.searchParams.delete(key);
  }
  url.searchParams.delete("url");`));
cpSync(join(upstream,'LICENSE'),join(out,'LICENSE'));
mkdirSync(join(out,'LICENSES'),{recursive:true});for(const n of ['CC0-1.0.txt','OFL-1.1.txt'])cpSync(join(upstream,'LICENSES',n),join(out,'LICENSES',n));
writeFileSync(join(out,'THIRD_PARTY_NOTICES.md'),`# RNL Viewer\n\nUpstream rich-netlist/rnl @ ${pinned}. UI 0.5.1, core @rich-netlist/runtime 0.5.3.\nCopyright 2026 many-question. Code MIT; standard packages CC0-1.0; Noto font metrics copyright 2014-2021 Adobe under OFL-1.1.\nLocal changes: additive ic-selection-bridge.js and index script tag; two inline startup scripts externalized for strict CSP; system-font fallback; no external package catalog; build metadata; CircuitGit Studio URL redirect, renderer-relative catalog URLs and detached-window routing.\nThis interface is the upstream RNL Viewer, not a recreation. Selection adapter is project-specific and not an upstream API guarantee.\n`);
function files(dir){return readdirSync(dir).flatMap(n=>{const p=join(dir,n);return statSync(p).isDirectory()?files(p):[p]});}
const inventory=files(out).map(p=>({path:relative(out,p),bytes:statSync(p).size,sha256:createHash('sha256').update(readFileSync(p)).digest('hex')}));
writeFileSync(join(out,'provenance.json'),JSON.stringify({upstream:'https://github.com/rich-netlist/rnl',commit:pinned,viewer_version:'0.5.1',core_version:'0.5.3',files:inventory},null,2)+'\n');
console.log(JSON.stringify({output:out,files:inventory.length,bytes:inventory.reduce((n,f)=>n+f.bytes,0)}));
