<p align="center"><img src="docs/assets/circuitgit.svg" width="128" alt="CircuitGit 图标"></p>

# CircuitGit

**AI 原生电路设计，让每一次电路修改都能在 GitHub 上追踪。**

**[查看产品展示](https://circuitgit-dev.github.io/CircuitGit/workflow/index.html)** · [打开网页工作台](https://circuitgit-dev.github.io/CircuitGit/) · [本地开源仿真](docs/open-source-simulation.md) · [Windows / macOS 兼容与测试](docs/cross-platform-testing.md) · [连接 Codex 节点](docs/remote-node.md) · [English](README.md)

CircuitGit 是面向本地电路设计与 Git 电路版本管理的 AI-native 环境，原生支持 **macOS、Windows 10/11 与 Linux**。Agent 直接读写本地 checkout 中的电路源，RNL 呈现原理图，本地 `ngspice`/`Xyce`（含开源 PDK）或远端商业 Spectre 执行仿真，Git 保存可审阅的设计变化。日常源编辑、看图与本地开源仿真不依赖在线 Virtuoso 会话或商业许可；需要远端商业仿真时，由 SpiceOwl 工具协助准备环境、监督运行和分析结果。

## 核心新特性

- **原生跨平台支持（macOS / Windows 10/11 / Linux，网页零命令行）**：Windows 双击 **`Start CircuitGit.bat`**、macOS 双击 **`Start CircuitGit.command`** 启动一次本机助手即可，日常电路设计、仿真与 Git 协作全部在网页端点击完成；底层由统一零依赖兼容层 `platform_compat.py` 托管，并由 `check_structure.py` 静态门禁长期防止平台回归（详见 [跨平台兼容与测试指南](docs/cross-platform-testing.md)）。
- **本地开源仿真（ngspice / Xyce + 开源 PDK）与网页一键切换**：无需商业许可和 SSH 服务器，在网页 **Simulation → 环境与PDK** 即可自动检测本机 `ngspice`/`Xyce` 与 **`SKY130` / `GF180MCU` / `IHP SG13G2`** 开源 PDK，一键预检并切换；内置 `rc-smoke` 与 `open-cmos-inverter`（TRAN / DC / AC）开箱即跑（详见 [本地开源仿真说明](docs/open-source-simulation.md)）。
- **电路库完整 CRUD、Git 分支切换与跨 Cell 关联 PR**：支持在网页 **版本** 面板或通过 Agent/MCP 直接新建电路库、新建/克隆电路单元、创建与切换分支，以及提交包含多个关联单元的 Pull Request（详见 [电路库指南](docs/circuit-libraries.md)）。
- **网表 ↔ RNL 实时增量保布局与新仿真原理图探针**：编辑网表或打开开源电路（`rc-smoke`、`open-cmos-inverter` 或新建单元）时，自动生成绑定源码哈希的实时 RNL 原理图（`/api/schematic/live`），对未改动器件增量保留已有 `@RNL` 位置与走线，并为新运行的本地（`ngspice`/`Xyce`）与远端仿真自动生成通过 `validate_mapping()` 校验的 `ic.waveform-map.v1` 探针绑定，点击节点即可绘制实时波形。
- **全功能一键测试运行器与三端 GitHub Actions 自动测试**：新开发者或用户运行 `python3 -B tools/dev/run_tests.py`（Windows 用 `python -B tools/dev/run_tests.py`）即可一键验证全模块功能；[Cross-Platform CI](.github/workflows/cross-platform-ci.yml) 自动在 `macos-latest`、`windows-latest`、`ubuntu-latest` 三端持续跑测并支持手动触发。

## 产品展示

**[打开 CircuitGit 展示页：本地 AI 设计与 Git 电路管理](https://circuitgit-dev.github.io/CircuitGit/workflow/index.html)**

- 用架构图看清电路库、RNL、Agent、Git、测试平台 CI 和 SpiceOwl 六个部分如何协作。
- 查看真实的“反相器增加一级成为缓冲器”拓扑修改、原生 RNL 渲染，以及保存、提交和恢复记录。
- 对比 Virtuoso Bridge 与本地设计流程，了解 Agent 配置，以及如何通过网页开发者模式开发 CircuitGit 自身。

展示页结合框图、电路与已有仿真结果，说明工作台的优势和底层工程投入。Bridge 对比展示工作流程，没有声称测量过两者耗时。

**相关项目：** [SpiceOwl · 面向工程师与 Agent 的独立仿真管理工具](https://spiceowl-dev.github.io/spiceowl/workflow.html)。通过自己的控制台、CLI 和 SDK 管理服务器资源、PDK、任务监督与结果诊断，也可将其工具集成到 CircuitGit。

## 仿真集成

可选的 [SpiceOwl 仿真运行服务](docs/standalone-simulation-runtime.md) 会检查已注册服务器的资源，通过同一个 Runner 执行独立 Spectre、监控断线并从原生结果解析受支持的波形。CLI、本地网页和 Agent 使用操作员明确配置的权限；需安装配套固定版本，公开静态演示页本身不会执行远端仿真。

[确定性实验流程](docs/deterministic-experiments.md) 提供已注册的 prepare → run → inspect 配方：运行前固定源码、条件与模型依赖，之后在已有报告视图中分别查看五个证据维度。文档附有默认禁用、只含虚构数据的操作员配置示例。

[Agent 编写测试台](docs/agent-testbenches.md) 支持通用 DUT/TB 导入、运行前完整人工审阅、按服务器绑定的 PDK 缓存，以及已保存数据的 FFT/ADC 分析。审阅后的测试台按 `lib/<library>/<cell>/testbenches/` 版本化，并绑定同一电路与运行记录进行 CI 分析。自动实验验收使用单个标量瞬态导出；单独选择原生 AC 或非扫描 DC 数据集，还可分析 Bode 曲线和工作点，但不会自动启用 AC/DC CI 验收。

- **电路作为代码管理**：按 `lib / cell` 查看源码差异与历史；保存前后检查点、提交、创建或更新 PR、选择 TB CI，并将历史版本恢复为新修改。详见[电路版本流程](docs/circuit-libraries.md#cell-version-workflow)。
- **保留原理图布局**：导入包含位置、方向和走线的几何数据，避免只靠网表自动排版。
- **可复现的仿真流程**：配置 → 审阅 → 计划与预检查 → Spectre 提交 → 收集结果 → GitHub 归档。
- **交互波形**：已保存的电压与端口电流、节点探针、游标，以及缩放/平移时的抽样绘制。
- **AI 工具接口**：通过 MCP 提供项目读取、受控修改、仿真和结果访问；在线网页也能授权连接自己的 Codex 运行节点。

![CircuitGit workbench](docs/assets/workbench.png)

## 网页演示能做什么

打开 [GitHub Pages 演示](https://circuitgit-dev.github.io/CircuitGit/) 后，可拖动窗口、查看固定布局的 RC 原理图，在 Plot 菜单选择探针，再点击节点或 R0；波形支持滚轮缩放、拖动平移和游标。仿真面板可调整参数并导出网表与 JSON 配置。

**示例波形是浏览器计算的 RC 解析参考，不是 Spectre 运行结果。** 打开网页不会自动探测本机、启动模型或提交仿真。

[产品展示页](https://circuitgit-dev.github.io/CircuitGit/workflow/index.html) 还包含独立 Bootstrap 与反相器运行所保存的原生 Spectre 波形及独立复算指标。先前的十阶段接入快照作为历史参考保留；这些后续运行不代表原快照的待审请求已经完成。

从 **电路库** 打开 `lib → cell → view` 管理器，可以浏览已迁移的 ADC 电路、原始连线和元件布局，以及各自的说明文档。切换到 ADC 时会清除 RC 示例波形；缺少模型或仿真输入的快照会明确说明，不能直接当作可运行工程。[电路库使用与目录规范](docs/circuit-libraries.md) · [库清单](lib/README.md)

AI 面板默认只需点击 **连接本机 Codex**，在本机窗口确认授权后，自动检查 Codex 登录状态；不需要输入地址或访问码。若 Codex 尚未登录，可继续打开由 Codex 返回的官方登录页面。授权后选择实际工程，即可使用模型选择、思考强度、图片和多会话功能。

首次需启动本机连接助手：Windows 用户在下载的项目包中双击 **Start CircuitGit.bat**，macOS 用户双击 **Start CircuitGit.command**，保持助手运行即可（需要 Python 3.11+、Git，以及可选的 `ngspice` 或 Codex；日常操作全部在网页内点击完成，无需使用命令行）。首次启动会在项目虚拟环境中安装固定 commit 的 SpiceOwl 及 `adctools` 依赖（NumPy、SciPy、ADCToolbox 0.9.3），不修改全局 Python。网页不会扫描其他端口或读取认证文件。自托管服务器的地址/访问码入口已收进「高级」设置。[连接说明](docs/remote-node.md) · [跨平台兼容与测试指南](docs/cross-platform-testing.md)

AI 的连接、账户、工程、模型和思考强度统一放在聊天输入框旁的 **齿轮设置** 中。选择「当前网表」可把导入源码和仿真接入会话交给 AI，返回结果只更新对应的仿真面板。其他节点工程与公开电路库浏览状态分别显示。它使用节点已有的 Codex 登录与模型权限，尚不提供面向所有访客的订阅 OAuth，也不会导入桌面窗口。现有电路修改和手动仿真请求保留人工审批；可选独立仿真服务需要另行安装明确的连接权限配置。

## 本地运行

```bash
git clone https://github.com/CircuitGit-dev/CircuitGit.git
cd CircuitGit
python3 -B tools/workbench/launch.py
```

需要 Python 3.11+ 与 Git。打开 `http://127.0.0.1:8766/`。首次启动生成被 Git 忽略的本地配置，本地包含无需 PDK 的 RC 示例；提交真实仿真前需配置自己的 SSH、Spectre 和模型依赖。独立 Spectre 流程不调用 Virtuoso 或 OCEAN。

本公开仓库包含应用源码、构建工具、MCP 插件、通用导出/仿真工具、RC 示例和审核后的用户 ADC 原理图导出。`lib/` 中保留来源哈希及模型依赖说明。PDK 实现、服务器配置、对话和未经整理的运行档案留在原工程中；详见 [发布范围](docs/public-release.md)。

## 开发环境与跨平台测试（macOS / Windows / Linux）

CircuitGit 已通过统一跨平台兼容层（`platform_compat.py`）原生支持 **macOS、Windows 10/11 与 Linux**，并由 `tools/dev/check_structure.py` 静态门禁和 [跨平台自动测试工作流](.github/workflows/cross-platform-ci.yml) 持续保障后续功能不引入平台回归。

macOS / Linux 下用一个命令准备项目 Python 环境、构建网页与插件及 Pages，并执行离线健康检查：

```bash
python3 -B tools/dev/setup_env.py
```

脚本初始化并同步官方 `submodules/rnl` 和 `submodules/spiceowl`，按 `contracts/spiceowl-integration.lock.json` 安装固定 commit 的 SpiceOwl `[mcp,adctools]` 与 **ADCToolbox 0.9.3**。优先从已核验的本地 SpiceOwl 子模块导出源码包供 pip 安装，避免重复下载 Git 仓库；重复执行复用匹配的项目环境。浏览器继续使用已编译的 RNL JavaScript/Wasm，普通使用及 Pages 构建不需要 Rust。它不修改全局 Python、不重启已有服务，也不安装 Node、浏览器、Cadence 或 PDK。可先加 `--plan` 查看步骤。解释器选择、失败恢复和可选外链审计见[开发环境说明](docs/dev-environment.md)。

在 macOS、Windows 或 Linux 上运行与 CI 一致的**全功能一键测试工作流**（覆盖跨平台门禁、打包、本机助手、本地开源 `ngspice`/PDK 仿真、电路库 CRUD/分支/PR、AI/MCP 以及前端测试）：

```bash
# 全量测试（Windows 下使用 python）
python3 -B tools/dev/run_tests.py

# 快速全模块冒烟测试
python3 -B tools/dev/run_tests.py --quick
```

详细测试矩阵、Windows/macOS 兼容维护规范与 GitHub Actions 手动触发方式见 [跨平台兼容与测试指南](docs/cross-platform-testing.md)。单独检查仓库文档内链与迁移后的第一方文档 URL：

```bash
python3 -B tools/dev/check_links.py
```

## 致谢

基于 [Rich Netlist](https://github.com/rich-netlist/rnl) 和 Dockview 等开源组件。项目采用 MIT 许可证，第三方代码及字体保留各自许可证和署名，详见 [第三方说明](THIRD_PARTY_NOTICES.md)。
