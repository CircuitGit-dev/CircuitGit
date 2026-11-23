// Exact, replayable adaptation of the pinned viewer's selected-object status.
import {createHash} from 'node:crypto';
export const selectionBaseSha256='039880a083d6d74f8e0aae07a08c6ea0091cbbc686c5bd14201c226a22ef28ae';
export const selectionPatchId='selected-instance-properties-v1';
const importLine='import { selectedInstanceProperties, appendInstanceProperties } from "../../../../modules/schematic/instance-properties.js";\n';
const callLine='  appendInstanceProperties(sel, selectedInstanceProperties(doc, o));\n';
const hash=source=>createHash('sha256').update(source).digest('hex');
export function selectionBase(source){
  const base=source.replace(importLine,'').replace(callLine,'');
  if(hash(base)!==selectionBaseSha256)throw Error('selection.js differs from the reviewed pinned base; review this patch before importing a new viewer.');
  return base;
}
export function applySelectionProperties(source){
  const base=selectionBase(source);
  const patched=base.replace('import { usageSelection } from "./usages.js";\n','$&'+importLine)
    .replace('\n}\n\nexport function clearSelection()', '\n'+callLine+'}\n\nexport function clearSelection()');
  if(source!==base&&source!==patched)throw Error('selection.js has a partial or divergent local adaptation.');
  return patched;
}
export const selectionNotice='CircuitGit displays the selected instance’s literal model and dimensions from its exact Document source span in the existing status bar; the shared read-only inspector lives in `modules/schematic/instance-properties.js`. This local adaptation does not change the drawing, netlist or parameter expressions.';
export function appendSelectionNotice(source){return source.includes(selectionNotice)?source:source.trimEnd()+'\n\n'+selectionNotice+'\n';}
