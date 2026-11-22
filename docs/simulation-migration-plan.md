# GitHub仿真迁移方案与清单

最终源码接口是 `portable/INTERFACE.md`。最小项目主线为 `design_id=real-sar-20261106`，TOP=PIPE_TOP_F4_RS9_N06，TB=TB_PIPE_RS9_N06，history=Interactive.0，LOW/NYQUIST。ideal、MDAC分别保留，不覆盖成同一baseline。

## 三层保存

| 层 | 保存内容 | 不进入此层 |
|---|---|---|
| 私有Git项目 | 项目自有OA/semantic、源网表、VA、测试bundle、save/solver参数、分析代码、受审结果摘要与hash清单 | PDK/model body、凭据、许可证配置值、运行cache/lock、大PSF |
| 本地机器配置 | site.local.json、SSH alias、服务器路径、个人输出目录 | 不提交Git，不把.env原样复制到其他机器 |
| 授权服务器 | 站点Cadence/PDK、外部stdcell adapter、隔离ic_on_github_runs/<run_id>及结果 | 不复用活动ADE目录、CIW或历史submission ID |

Maestro的active.state/maestro.sdb、test_states、表达式等作为原生配置快照由主会话OA闭包承接；同时以可diff的JSON保存真实测试参数与求解选项。锁文件、消息数据库、历史results和.codex_runs不作为可执行源。编辑新的配置应在隔离副本中；当前活动ADE保持原样。

## 清单

- [x] 定位并hash原始7项测试的netlist/log/config及Nov6波形。
- [x] 识别real-SAR5个VA快照、save文件、discontinuity=robust数值include。
- [x] 显式记录PDK七个section、外部SVT/LVT库、内联ULVT定义边界。
- [x] 独立CSV数值交叉检查；保留MDAC失败结论。
- [x] 实现通用plan/preflight/run/status/collect；既有文本网表可以直接进入bundle。
- [x] 修复csh登录壳多行引号；真实只读preflight与768字节binary回环通过。
- [x] 离线shell测试：hash/依赖/路径拒绝、损坏tar、原子run目录、单次launch、失败终态。
- [ ] 主会话提交正式OA/netlist闭包、ULVT adapter及规范bundle；不得仅把原始结果目录复制进Git。
- [ ] 当前许可证checkout与site setup→真实Spectre新运行验证。
- [ ] 真实结果回收与独立OCEAN指标复算；不在本轮启动昂贵仿真。
- [ ] PDK递归文件锁定/版本清单、原始AHDL源码绑定；历史bundle无法用当前hash自动补证。

## 一条命令与恢复

本轮只执行过plan/preflight。未来bundle完成审查和commit后，通用命令为：

```bash
python3 tools/sim/ic_sim.py --site ~/.config/ic-on-github/site.local.json run --bundle sim/bundles/real-sar-low/bundle.json --execute --raw --results .sim-runs
```

路径中的bundle名称由集成人最终确定，不能未经核实就视作已经存在。`run`包含预检、冻结清单、staging、单次提交、等待、collect；源码commit及配置hash随run.json保留。来源history是参考标签，新run_id不写回Maestro。断线/超时保留receipt，执行status/collect；不新建run来重试未知结果。此原型不提供自动kill/清理。

模型与setup在提交前和job开始时验hash。服务器目录隔离是工作目录及输出路径约束，并非容器/权限沙箱；正式源包仍需审查绝对输出文件路径。对于外部PWL/波形等额外输入，需显式列入files并使用包内相对路径。工具不会自行打包PDK。

GitHub hosted CI仅运行离线静态检查。授权服务器执行Spectre，未来可由人工workflow_dispatch或可信自托管runner触发；本轮只提供静态workflow模板，没有安装runner或配置secrets。

## 本地设置、后处理与比较

保留Fin/Fs/cycle/N/Tper的一致性：Nov6 1GS/s，N=16，cycle1/7，Fin62.5/437.5MHz，Tfft4ns，stop24ns。源参数必须在原声明处修改，不能追加覆盖依赖表达式。quantizer=2Vpp与input=1.8Vpp独立；不得为了匹配输入而缩小满量程。

real-SAR采样n4…19，末级读码n+2.45ns，保持值n+0.40ns，粗码/残差n+0.98ns。保留非二进制权重216/140/72/38/20/12/6/4/2/1及既有极性。C=256K+Q−128；电压中心重建(C+0.5)/2048−1。FFT用16点矩形相干窗，SNDR排除DC和基波；不可擅用正弦拟合/校准扣误差。

优先保留PSFXL及独立OCEAN导出。原 `postprocess_Interactive.1_exprfix.ocn` 可作表达式参考，但其绝对PSF和输出路径需改为run相对路径，且只能在自己的OCEAN进程中运行。当前CLI不自动执行它，通用bridge ASCII parser也不能直接读PSFXL。

参考演讲HTML已读取并留在evidence/reference.html；本轮仅采用其文本化、可审查的组织思路，未引入Rich Netlist依赖或据此宣称工具兼容性。
