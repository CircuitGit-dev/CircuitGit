# 迁移设计与后续路线

本轮采用原生OA+文本电路/配置。RNL不是前置依赖。

## 设计身份和证据

| design_id | top / TB | 历史 | 本轮定位 |
|---|---|---|---|
| real-sar-20261106 | PIPE_TOP_F4_RS9_N06 / TB_PIPE_RS9_N06 | Interactive.0 | 首条OA→网表→独立仿真包验证主线 |
| mdac-array-20261106 | PIPE_TOP_CA4_RS9_N06 / TB_PIPE_CA4_RS9_N06 | Interactive.1 | 新MDAC候选，保留精度限制 |
| ideal-baseline-20261020 | PIPE_TOP_F4_TI2_S9 / TB_PIPE_TOP_1G | Interactive.9 | 已完成理想行为模型历史，不能等同当前OA |

`design/variants/*/design.json`绑定historical design netlist SHA256、portable circuit SHA256、OA snapshot manifest SHA256。每个仿真bundle进一步绑定具体test、参数、analysis、solver、source文件和外部模型hash。新的独立运行以run_id和Git commit标识，历史Interactive编号只是出处。

## 依赖和环境

项目原本通过站点`cds.lib`引用`tsmcN28`、analogLib/basic、LVT/SVT标准单元库及ULVT库。原`.cdsinit`、`.cdsenv`、`display.drf`是指向共享PDK目录的符号链接。这些内容不能只靠拷贝项目目录自动得到。

恢复时必须提供：

1. 对应Cadence IC6.1.8/Spectre安装与可用许可；本轮版本证据为IC6.1.8-64b.500.26，历史Spectre 21.1.0.509.isr12。
2. 相同技术库及model corner sections、CDF/PCell回调和标准单元接口。包只记录引用，不分发实现。
3. 站点环境初始化脚本、site cds.lib，以及项目恢复目录。不要复制SSH私钥、bridge token或许可证设置。
4. 独立仿真目录`ic_on_github_runs`；与活动ADE历史目录分开。

OA restore工具保留library/cell/view文件及data.dm，不用文本处理二进制。技术库版本和外部标准单元仍是必要依赖；仅有OA或仅有网表不能承诺在任意机器直接运行。

## 原始layout参考

已保存原始`2026_PIPESAR`的10个SAR源cell。其中9个有layout，`L6_9bit_REF_Logic`无layout。layout的实际子实例闭包尚未逐个遍历验证，部分版图可引用不在这10个cell中的原库对象。其余layout变体和calibre提取视图在清单中列出但没有复制。

这份参考不绑定新PIPETISAR整机验证，不混入real-SAR运行包。下一阶段需要：layout层级闭包 → 所需自有子cell归档 → 外部PCell/标准单元映射 → 版图恢复 → DRC/LVS → 提取视图/网表hash → 新后仿真run_id。将来GDS/OASIS是制造交换/快照；OA仍用于可编辑设计，二者都不替代提取规则和技术库。

## 分阶段推进

本轮已保存源设计、建立文本review面、验证原生导出和仿真输入闭包，普通GitHub CI不需要PDK。

下一步在同一固定commit运行一次低频短仿真，按原有译码和采样窗比较PSFXL/CSV及指标，随后扩展高频、长记录、PVT和失配回归。每个实验使用新目录和receipt；等待超时先查status，不重复提交。

再后续才接入受控的内网runner。GitHub负责commit/PR和静态检查，有许可的服务器负责求解。只对受信分支与明确工作流开放EDA执行，避免任意PR代码直接进入EDA环境。

归档里保存的Maestro XML可用于恢复人工ADE工作；当前自动执行以文本bundle为准。切勿把历史Maestro中的绝对结果路径直接指向新项目并覆盖旧结果。重建新ADE配置时核对test/corner/变量/outputs，保存后导出文本再进入版本管理。
