// Adapter for the pinned RNL document component. The host owns layout, startup and project loading.
import {startI18n} from '../vendor/rnl-viewer/i18n.js';
import {loadShell} from '../vendor/rnl-viewer/shell.js';
import {load,startSettings} from '../vendor/rnl-viewer/util.js';
import {save} from '../vendor/rnl-viewer/util.js';
import {startPool} from '../vendor/rnl-viewer/pool.js';
import {startUsages} from '../vendor/rnl-viewer/usages.js';
import {startNetlistColors} from '../vendor/rnl-viewer/netlist-colors.js';
import {setBackground} from '../vendor/rnl-viewer/background.js';
import {command,isChecked,setCheck,startCommands} from '../vendor/rnl-viewer/commands.js';
import {gridState,setGrid} from '../vendor/rnl-viewer/grid.js';
import {setHoverNames} from '../vendor/rnl-viewer/hover.js';
import {showMenuBar} from '../vendor/rnl-viewer/menubar.js';
import {setIndexHeight,setPane,setProblems,setProblemsHeight,setShowFailed,setSidebar,setSidebarWidth,phone,lowPhone} from '../vendor/rnl-viewer/panels.js';
import {setSemanticsOnly,setRnlOnly} from '../vendor/rnl-viewer/text.js';
import {renderUnplaced} from '../vendor/rnl-viewer/unplaced.js';
import {current,doc,path,selected} from '../vendor/rnl-viewer/state.js';
import {dirtyPaths,unappliedPaths} from '../vendor/rnl-viewer/edits.js';
import {note} from '../vendor/rnl-viewer/editor.js';
import '../vendor/rnl-viewer/ic-selection-bridge.js';

let started;
export function startSchematic(){return started ||= start();}
async function start(){
  const shell=await loadShell();await startSettings(shell);
  const unavailable=await startI18n(shell,load('language',null),value=>save('language',value));if(unavailable)note(unavailable,12000);
  setBackground(load('background','light'));startNetlistColors();startUsages();
  setSidebarWidth(load('sidebar-width',300));setProblemsHeight(load('problems-height',180));
  setSidebar(phone.matches?false:load('sidebar-shown',true));setProblems(lowPhone.matches?false:load('problems-shown',true),!lowPhone.matches);
  setPane(load('side-pane','hierarchy'));setShowFailed(load('show-failed',true));setSemanticsOnly(load('semantics-only',false));setRnlOnly(load('rnl-only',false));setCheck('toggle-edit',false);setIndexHeight(load('index-height',260));
  setGrid({shown:load('grid-shown',true),style:load('grid-style','dots'),spacing:load('grid-spacing','auto'),major:load('grid-major',5),axes:load('grid-axes',false)});setHoverNames(load('hover-names',true));renderUnplaced();
  // Pool/core preparation and command metadata have independent inputs.
  await Promise.all([startCommands(),startPool()]);showMenuBar(true);
  document.getElementById('sidebar').addEventListener('contextmenu',event=>{if(!event.target.closest('input,textarea,select,[contenteditable]'))event.preventDefault();});
  window.viewer={get doc(){return doc;},get level(){return current;},get path(){return path.map(step=>({...step}));},get selected(){return selected;},command,checked:isChecked,get grid(){return gridState();},menuBar:showMenuBar,get edits(){return {unsaved:dirtyPaths(),unapplied:unappliedPaths()};}};
}
