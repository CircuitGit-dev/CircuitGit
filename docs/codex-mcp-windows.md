# Codex 原理图、波形与仿真窗口

同一 MCP 服务提供三个独立的 MCP App 资源。网页工作台继续使用 `apps/web/`；Codex 窗口使用 `apps/codex/ui/`，共用电路模型、波形和仿真配置逻辑。模型对话使用 Codex 本身。

日常使用请安装 [IC Workbench 插件](plugin.md)。它自动管理本地启动并提供宿主人工确认。下面的 Python 和直接 MCP 配置保留给开发、调试和兼容使用，用户无需手动运行。

## 构建与连接

```bash
python3 -B tools/dev/build.py all
python3 -B tools/dev/check_structure.py
```

构建输出包含 `dist/ic-workbench/ui/schematic.html`、`waveforms.html` 和 `simulation.html`。它们是可通过 `resources/read` 获取的完整 MCP App 文档，不是外部工作台网址。源码在 `apps/codex/ui/`，不要直接修改生成的 HTML。

工作台网关需要先运行。新建私有客户端配置，明确网关和独立状态目录：

```json
{
  "gateway_url": "http://127.0.0.1:8766",
  "state_dir": "/absolute/private/ic-workbench-mcp-state",
  "timeout_seconds": 30
}
```

保存为本地 `config/codex-mcp.local.json`。配置和状态目录不加入 Git。使用绝对路径连接原生 Codex MCP：

```bash
codex mcp add ic-workbench -- python3 -B \
  /absolute/IC_on_Github/dist/ic-workbench/ic_workbench.py \
  --config /absolute/IC_on_Github/config/codex-mcp.local.json mcp
```

安装步骤会修改本机 Codex 配置，应由使用者明确执行，或授权协调者执行。保持现有审批设置。如果工具目录尚未刷新，重新进入会话再检查 `ic_*` 工具是否可见；仍未出现时检查连接状态，不能把浏览器测试当作已接入。

如需分发完整插件，离线运行 `python3 -B tools/dev/marketplace.py`，生成 `dist/codex-marketplace/`。它包含本机安装目录和自包含插件。插件方式使用宿主提供的 `PLUGIN_DATA/config.json`，不要猜测路径或把站点配置放进插件包。直接 MCP 与完整插件任选一种连接，避免重复注册。

## 打开窗口

先调用 `ic_projects` 获取真实项目与配置 ID。

| 工具 | 用途 |
|---|---|
| `ic_schematic_open` | 原生 RNL 原理图、层级、节点与端口选择 |
| `ic_waveforms_open` | 指定 run 的已保存电压、电流与游标 |
| `ic_simulation_open` | 配置表单、修改预览、计划与请求回执 |

第一个入口返回 `workspace_id`；为相关窗口复用此 ID，才能共享选择。每个窗口有独立 `view_id` 和版本号。波形必须明确 `run_id`，不能把最新运行默认为当前电路结果。

可以向 Codex 说：

> 打开 real-sar-20261106 的原理图和 PIPE_LOW 仿真配置，再打开指定历史运行的波形窗口；让三个窗口使用同一工作区。

窗口可请求宿主支持的显示模式。侧栏、全屏及布局取决于宿主返回的能力；代码不会用网页弹窗模拟原生窗口，也不保证任意停靠组合。

## 原理图与波形联动

原理图继续使用已导出的元件位置、走线和符号。选择网络或明确端口后，将选择发布到工作区；波形窗口读取同一工作区的选择，与该 run 保存的映射和来源证明核对。字段缺失、来源过期、库快照或端口不明确时显示具体原因；历史波形目录仍可独立使用。

模型上下文只包含身份、信号和必要游标摘要。大块原图与曲线样本通过 UI 专用数据传递，不塞入对话。

## 配置与执行

表单写入窗口自己的草稿。预览使用真实差异与校验；计划使用已提交版本。保存配置、提交仿真、收集或归档首先创建持久请求，返回请求 ID、指纹和状态。

插件中的“在 Codex 中审核”通过 `ic_request_review` 请求宿主人工表单。这个工具只接收请求 ID 和指纹，不能携带模型伪造的确认参数。只有对应的宿主表单回应可以执行批准；取消、不支持或超时继续保留待审批。CLI `approve` / `deny` 保留为兼容接口。请求处于未知或派发中时查询原回执，不重新生成幂等键或再次提交。

提交被用户批准后，可将回执中的运行绑定回原仿真窗口。绑定必须来自这个窗口自身的请求，验证项目、配置与源码版本。查看其他历史运行时，显式打开绑定该 run 的新窗口。

## 验证范围

```bash
python3 -B tests/codex/test_views.py
node --test tests/codex_ui/host.test.mjs
python3 -B tests/codex_ui/test_packaging.py
```

可选的 `tests/codex/acceptance.mjs` 通过真正的 stdio MCP 读取已有网关数据，在隔离的 MCP Apps 测试宿主验证三个完整资源。它阻止生产 POST，不调用模型、SSH 或仿真。需要本机 Playwright/Chrome 和既有数据，可设置 `PLAYWRIGHT_MODULE`、`IC_PYTHON`、`IC_GATEWAY_URL`、`EVIDENCE_DIR`。

原生 Codex 实际挂载、宿主 CSP 和工具加载必须另行观察。资源返回、组件报告 loaded、测试宿主通过，分别代表不同阶段，不等于已在桌面显示。
