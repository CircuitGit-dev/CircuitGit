import {inform} from '../vendor/rnl-viewer/dialog.js';

const mounted = new WeakMap();
const topics = [
  ['项目与原理图', '在顶部选择项目和原生入口，左侧查看网表、层级与符号。canonical 对应仿真源码；独立库入口用于查看导出快照。源码修改后，旧图形关联可能失效。'],
  ['源码与 Git', 'Git → 版本管理默认显示电路和仿真配置历史，纯注释 / 格式变更可单独勾选。选择历史提交可预览回档，再确认生成新提交，原历史保留。编辑源码、保存配置或回档时，预览差异后 AI 使用本地默认模型拟写标题和更新说明，可以手写修改；生成说明不会自动提交。↑ / ↓ 来自本地跟踪缓存，拉取时才检查远端。需要同步到 GitHub 时勾选推送。'],
  ['仿真与外部连接', '仿真面板分为“配置 / 提交 / 运行”。配置页查看瞬态分析、参数与保存信号；提交页预览差异并保存后，生成计划、远端预检，再手动批准提交。网关按已有站点配置连接远端 Cadence/Spectre。任务列表查看运行记录，Simulation 收集结果，Git 归档到私有 GitHub。'],
  ['仿真监督记录', '运行页的 SpiceOwl 区域显示所选任务已保存的执行状态、观察时间、数据收集与指标记录；可打开对应的保存波形。刷新只读取本地记录，不检查远端仿真器。记录缺失或读取失败会明确标出。'],
  ['保存信号与波形', 'Spectre raw 保存决定仿真保留什么，OCEAN 导出决定从已有数据提取哪些曲线。顶部选择运行后，用 Plot → 电压探针点击节点；电流探针需选择器件端子。波形在独立窗口显示，Esc 退出探针；未保存或未映射的信号不能直接绘制。'],
  ['AI 与模型', '点击输入框旁的齿轮可选择下一条消息的模型、思考强度和操作权限。强度按模型提供的档位显示；沿用会话不覆盖当前设置，模型默认使用目录默认值。只读仅查看电路与已有数据，人工批准保持原有变更审批。Enter 发送，Shift+Enter 换行，中文选词不会误发送。执行步骤可展开；服务故障后可点“恢复输入 / 更换模型”，旧请求不会重发。'],
  ['开发者模式', '在齿轮设置的操作权限中选择开发者模式，可开发工作台程序并发布本地前端更新。设置会显示本机配置的权限和初始工作目录：完全访问允许读写本机文件、执行命令及联网，无需逐项审批；人工批准仍逐次审阅扩展权限请求。普通电路模式保持原审批流程。输入框自动扩展至四行，模型和权限可收起；后端重启需等待活动对话结束。'],
  ['多会话与窗口', '会话栏的“管理”或 Window → AI：对话管理器可搜索对话，查看模型与状态、切换、重命名或删除。最多保留 8 个列表对话；删除释放名额，本地历史、图片和操作回执仍保留。默认对话保留，运行中或仍有审批的对话不可删除。各对话保留自己的历史和模型，共同操作当前项目源码。隐藏或切换不会停止后台回合，停止 AI 也不会取消已提交的仿真。Window 可显隐面板和恢复默认布局，拖动分隔线可调整大小。']
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
  const unregister = host.registerCommand({id: 'help.workbench', menu: 'help', label: '工作台新增功能…', run: showHelp});
  const controller = {destroy() {unregister(); mounted.delete(host);}};
  mounted.set(host, controller);
  return controller;
}
