# 4b 电容阵列 MDAC 集成与验证（2026-11-06）

状态：电容阵列 MDAC 已完成搭建、全码验证和整机接入验证。D4 版本的整机 12 位精度尚未达到原基线，以下将 MDAC 验证与整机精度分开报告。

## 本轮实现

所有电路写入均在 `2026_PIPETISAR_RESEARCH`。原 `PIPE_TOP_F4_RS9_N06` / `TB_PIPE_RS9_N06` 基线保留。

| 新 Cell | 用途 |
|---|---|
| MDAC4_MOM_BIT_N06 | 差分 MOM 单元、输入采样开关、真实参考 MOS |
| MDAC4_REF_CTRL_N06 | 4 组参考控制，共 20 个实际 NAND2 |
| MDAC4_ARRAY_G8_N06 | 4b 电容阵列与闭环理想 OTA |
| PIPE_TOP_CA4_RS9_N06 | 实际 Flash、新 MDAC、两路实际 9b SAR |
| TB_PIPE_CA4_RS9_N06 | 整机原理图和 Maestro |
| TB_MDAC_CA4_N06 | 全 16 粗码独立测试原理图和 Maestro |

每侧采样电容为 `8Cu + 4Cu + 2Cu + Cu + Cdummy`，反馈为 `2Cu`。
Cu 使用已有 tsmcN28/cfmom_2t 的相同几何，名义 99.8585 fF；Cs=1.597736 pF/side，Cf=199.717 fF/side。
这些是模型名义值，不是版图提取结果。

输入采样时 16Cu 全部采样 VIN；放大时加权 15Cu 按 Flash 二进制码切到互补参考轨，dummy 接 VCM。
设 K 为 0…15，VREFP=1 V、VREFN=0 V，则

`Vres,diff = 8 × [Vin,diff − (K−7.5)/8]`。

dummy 保持采样总权重为 16Cu，配合 2Cu 反馈得到 G=8。参考重建维持原来的 mid-rise 码中心。
数字合码保持 `C12=256K+Q9−128`，电压重建保持 `(C12+0.5)/2048−1`。
Flash 实际 BIN 总线同时连接参考控制和后级粗码捕获，没有行为级粗 DAC 或理想粗量化器。

## 参考驱动与修正

`H=AMP·K`、`HB=¬H`、`L=AMP·¬K`、`LB=¬L`。
AMP=0 时二进制支路参考开关关闭；AMP=1 时 K=1 使 P 侧接 VREFP、N 侧接 VREFN，K=0 反向。

第一版 LVT/30 nm 参考 MOS 出现保持漏电；全码测试最大输入等效误差约 787 µV。
改为 HVT/60 nm、每单元 W=500 nm、m=4，并执行 PDK 回调后，D0 逻辑版本全码误差降至 15.27 µV。

首次整机 Interactive.0 的码字配对、真实 SAR 译码和合码均正确，低/高频最大误差却分别为 2.977 / 2.572 LSB12。
波形显示 D0 最小 NAND 驱动高位加权 MOS 栅负载过慢；粗码在放大开始后更新，参考边沿和后级采样端持续收敛。
因此仅将参考控制 NAND 改为 D4；保持 250/250/500 ps 时序、HVT 参考 MOS、电容、OTA 和后级 S/H 参数。
更新网表比较确认原有子电路仅 MDAC4_REF_CTRL_N06 发生变化，另新增 D4 NAND 子电路。
首次整机结果保留为调试证据，不作为最终验收。

## 验证结果

最终电路：HVT/60 nm 参考 MOS + D4 NAND 驱动。独立测试为 `TB_MDAC_CA4_N06/Interactive.2`；整机为 `TB_PIPE_CA4_RS9_N06/Interactive.1`。

| 项目 | 独立全码测试 | 整机低频 | 整机近奈奎斯特 |
|---|---:|---:|---:|
| 输入 | 16 粗码、±40 mV 码内残差 | 62.5 MHz、1.8 Vpp | 437.5 MHz、1.8 Vpp |
| Spectre | 0 errors | 0 errors | 0 errors |
| 检查样本 | 全部 16 个粗码 | 16 | 16 |
| 参考逻辑 / 粗细码配对 | 全部正确 | 全部正确 | 全部正确 |
| 最大 MDAC 输入等效误差 | 1.57 µV（对施加的稳定输入） | 121.45 µV（对保持输入） | 106.87 µV（对保持输入） |
| 最大最终重建误差 | 不适用 | 2.017 LSB12 | 1.618 LSB12 |
| 最终码 SNDR | 不适用 | 62.457 dB | 66.128 dB |
| 最终码 SNR | 不适用 | 66.703 dB | 71.208 dB |
| 最终码 SFDR | 不适用 | 65.114 dBc | 70.340 dBc |
| 最终码 ENOB | 不适用 | 10.083 bit | 10.692 bit |

独立全码测试最大保持漂移约 0.744 µV；对 400 ps 时刻的保持输入比较，MDAC 误差约 1.279 µV。
整机均有连续 1 GS/s VALID、正确交织通道和码字配对，无溢出。实际 SAR 从 CLKB 到 EOC 约 694–710 ps（基于 5 ps 导出网格插值）。

`Flash + residue/8` 的诊断 FFT 分别约 80.96 / 81.46 dB SNDR。该链路保留连续模拟残差和理想 OTA，**不能当作最终 ADC 的 SNDR/ENOB**。
MDAC 误差均小于 244.14 µV（半 LSB12），但最终 12 位重建均未达到一 LSB；低频也略超过脚本预先设置的两 LSB 功能界限，不能标为整机精度验收通过。
D4 版本最大重建误差较 D0 减小，但低频 SNDR 没有同步改善；不能用其中一个指标代替整体结果。

误差分解显示，后级实际采样边沿附近的外部 S/H 跟踪滞后最高约 2.77 / 2.35 mV（残差侧）；SAR 码相对该外部采样电压的偏差最高约 4.11 / 3.81 mV。
后者还包含真实 SAR 采样动作、量化与电路误差，不能直接解释为比较器噪声。本轮保留了外部 S/H 的 50 Ω 和 500 fF，未通过数字校准掩盖这些误差。

在 n+980 ps 读取的单端残差包络，低频约 0.297–0.703 V，高频约 0.220–0.780 V。
0.25–0.75 V 是粗码正确、码内残差不超过半 LSB 时的名义包络；实际 Flash 采样/判决误差会使部分码超出此包络，由级间冗余承接。
4–24 ns 全部已保存自适应时间点的 ROP/RON 均位于 0–1 V；这里没有声明未保存瞬间的连续时间极值。

以上均为短记录、无瞬态噪声的前仿真。没有噪声、失配、PVT、后仿真或真实 OTA 功耗签核。

## 表达式、图形和复现

修复了 `FLASH_RECON` 的多余函数括号，并简化加权保持电压的 sample 表达式。只有结果后处理重算，没有重放昂贵的瞬态仿真。
Cadence 与 Python 的最终码 FFT、对齐波形点数及最大误差交叉核对一致；两项 Maestro 表格已有有效 SNDR/SNR/SFDR/ENOB 数值。
FFT 采用 16 点相干矩形窗；SNR 排除折叠后的二至五次谐波，SNDR 仅排除直流与基波，SFDR 使用最大非基波杂散。

关键观测量：`FLASH_RECON`、`FLASH_RA_RECON`、`07_FINAL_ALIGNED_V`、`08_HELD_INPUT_V`、`09_ERROR_INPUT_V`，以及两路 SAR CDAC 顶板。
`09_ERROR_INPUT_uV` 保留数值计算；绘图使用物理伏特形式的 `09_ERROR_INPUT_V`，让 ViVA 自动显示正确的 mV 量纲。
电容值由 PDK PCell 几何和实际实例个数决定，继承的 Cs1/Cf1/CuNominal 变量不是改变这些 PCell 电容的有效旋钮。

- 顶层原理图（原工程附件，见历史出处）
- 电容阵列 MDAC（原工程附件，见历史出处）
- 电容与参考 MOS 单元（原工程附件，见历史出处）
- 参考控制逻辑（原工程附件，见历史出处）
- 整机 TB（原工程附件，见历史出处）
- 全码 TB（原工程附件，见历史出处）
- 全码验证和修正对比（原工程附件，见历史出处）
- 全码原生波形（原工程附件，见历史出处）
- 参考控制原生波形（原工程附件，见历史出处）

两组整机的 `reconstruction_0.png`、`error_0.png`、`residue_0.png`、`timing_0.png`、`fft_0.png` 和对应 `.grf`，位于 `outputs/adc/mdac_array_20261106/results/TB_PIPE_CA4_RS9_N06/Interactive.1/PIPE_LOW/` 与 `PIPE_NYQUIST/`。
原生频谱同时显示 Flash 粗码、Flash 加残差、最终 12 位码，避免把不同链路性能混在一起。
独立 OCEAN 后处理脚本 `postprocess_Interactive.1_exprfix.ocn` 包含命名波形定义及原始 PSF 路径；读取此脚本可复现其原生图。

## 可复现设置

VDD=1 V，VCM=0.5 V，差分量化 FS=2 Vpp。Ain=0.9 V 为差分峰值；实际源是 VINP/N=VCM±Ain/2，即差分 1.8 Vpp。
主测试为 PIPE_LOW（62.5 MHz）和 PIPE_NYQUIST（437.5 MHz），各 24 ns、1 GS/s、16 点相干记录，排除启动样本，使用 n=4…19。
FFT_LOW / FFT_NYQUIST 的 64 点配置保留但关闭；未运行不能当成验证。

Maestro 保存关键重建、残差、时钟、真实 SAR CDAC 顶板与 FFT 输出；只有少量核心波形默认勾选绘图。
输出每周期在 n+2.45 ns 读码，并移回 n+0.40 ns 与采样电容的加权保持电压比较。
FFT 对原始码字重建计算，不进行增益校正、正弦拟合扣除或码校准。

## 仍属理想模型的部分

- OTA：原有受控源差分 OTA，闭环通过真实 MOM 反馈电容建立。
- 输入采样、复位、dummy 接 VCM、两路外部 S/H：用户的理想 Switch（relay + Rseries）。
- Clock、数字时序适配/译码/合码、输出限幅：行为模型。SAR 的比较器、CDAC 开关、异步控制为实际电路；原后级单位电容仍是理想电容。
- 电源、参考、输入与共模源理想。没有瞬态噪声、失配、提取寄生或 PVT 验证。

因此本轮替换的是粗 DAC 的模拟行为及其加权参考切换路径，尚不能称为全晶体管 ADC。
Spectre 有模型/SOA/LTE 告警；0 errors 只证明求解完成，不代表器件可靠性或数值精度已签核。

## 证据位置

主目录：`outputs/adc/mdac_array_20261106/`。
原始网表、Spectre 日志和波形 CSV 按 testbench / history / test 保存于 `results/`。
驱动脚本：`scripts/adc/mdac_array_20261106.py`；所有提交使用唯一记录和完成标记，未知结果不得重发。

## 最终保存检查

六个新原理图最终 Check and Save 均为 0 errors / 0 warnings。重新导出的 26 个子电路与最终实际运行网表一致；整理标注和连线显示没有改变电气实现。整机 Interactive.1 与单元 Interactive.2 已锁定以保留证据，锁定不表示整机精度达标。
