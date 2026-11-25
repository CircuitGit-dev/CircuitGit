import {inform} from '../vendor/rnl-viewer/dialog.js';
import {mountWorkflowLink} from './workflow-link.js';

const mounted = new WeakMap();
const topics = [
  ['项目、电路库与原理图', '在顶部选择项目与视图入口（或点击“电路库”浏览 Library → Cell → View）；左侧可按需展开网表、层级与符号。修改源码后，实时 RNL 同步会尽量保留已有器件布局并刷新原理图。'],
  ['统一工作台连接（Codex + SpiceOwl + Git）', '点击顶栏“连接本机助手 / 本机工作台”胶囊即可在单一入口查看并管理所有连接。在网页演示中一次授权本机助手后，AI Agent、远端服务器仿真（SpiceOwl / SSH）与本地电路库 Git/PR 会自动共享同一连接，无需在多个面板分别配对。'],
  ['远端优先的仿真工作流', '日常仿真以远端服务器（SSH + SpiceOwl / Spectre）为主：在“环境与 PDK”页导入/绑定网表、探测主机与商业 PDK、审阅测试平台并运行分析；在“配置 / 提交 / 运行 / 资源与监控”页管理项目级模板任务。本地开源仿真器（ngspice / Xyce）收拢在环境页底部的可折叠备选区。'],
  ['统一 AI 协同调度', '从仿真面板点击“请 Agent 检查环境与 PDK / 编写测试平台 / 诊断此运行”时，上下文卡片会直接送到现有 AI 对话区，复用同一个 Agent 会话。所有源码写入、测试平台审阅与仿真提交仍保留人工明确确认。'],
  ['波形面板与原理图探针', '波形面板默认内嵌在工作台下方，自带快捷工具栏（电压探针、电流探针、适配视图 F、游标测量 M、切换运行 O）。开启探针后点击原理图节点或器件端子即可点亮对应曲线，按 Esc 退出探针。'],
  ['源码与 Git 版本管理', '点击画布上方“查看 / 编辑源码…”或打开“版本管理”面板可查看差异、生成提交说明、回档历史版本与推送至 GitHub。纯注释 / 格式变更可按需过滤，历史记录始终完整保留。'],
  ['窗口布局与快捷键', '点击顶栏“窗口”可显隐任意面板或恢复默认布局；拖动面板标签可重组或浮动窗口。点击画布工具栏“侧边栏”可随时展开/收起网表与层级面板，为原理图留出更大空间。']
];

function showHelp() {
  const content = document.createElement('div');
  content.style.cssText = 'max-height:60vh;overflow:auto;line-height:1.65';
  for (const [title, description] of topics) {
    const section = document.createElement('section');
    section.style.marginBottom = '12px';
    const heading = document.createElement('h3');
    heading.style.cssText = 'font-size:13px;margin:0 0 3px';
    heading.textContent = title;
    const paragraph = document.createElement('p');
    paragraph.textContent = description;
    section.append(heading, paragraph);
    content.append(section);
  }
  return inform({title: 'IC on GitHub · 功能与用法', paragraphs: [content]});
}

export function mount(host) {
  if (mounted.has(host)) return mounted.get(host);
  const workflow = mountWorkflowLink(host);
  const unregister = host.registerCommand({id: 'help.workbench', menu: 'help', label: '工作台新增功能…', run: showHelp});
  const controller = {destroy() {unregister(); workflow.destroy(); mounted.delete(host);}};
  mounted.set(host, controller);
  return controller;
}
