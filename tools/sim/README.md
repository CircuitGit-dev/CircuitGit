# PIPETISAR 独立仿真原型

这是通用 standalone Spectre CLI 可集成包，不是新仿真结果。Nov6 real-SAR 的两个24ns测试是迁移参考 profile；正式项目 bundle 由主会话生成。ideal baseline、real-SAR、MDAC 的历史身份与设置在 `historical-runs.json`，其验收范围不同。

先读 [INTERFACE.md](INTERFACE.md)。本轮不接 Rich Netlist。主会话负责权威 OA、schematic、项目源闭包及 Git 写入。

```bash
python3 -B test_ic_sim.py
python3 -B ic_sim.py --site site.local.example.json plan --bundle fixtures/bundle.json
```

以上命令完全离线。fixture 只测试传输配置，不是 ADC。已有文本网表可直接列入 bundle，不必先经过 OA/bridge。纯文本网表用 `design_origin=text-netlist`，无需伪造 library/history。用户或原生 netlister 决定电路；本 CLI 不网表化 OA。

`simulator.profile=nov6-aps2` 明确选择历史 `-64 +aps +mt=2`；默认 `spectre-default` 仅指定 `-64`。其他设计可用 `simulator.args` 和 `output_format` 指定自己的求解参数。tran、容差、参数、save 仍来自源网表，不会静默套用 PIPETISAR 设置。

集成后，把模板复制为忽略的 `site.local.json` 并填写外部模型路径。人工检查项目闭包/厂商边界后才设置 bundle 的 `reviewed_for_distribution=true`，然后提交 Git。不要把历史 source commit 填成新 commit；旧来源由 history 和原始哈希追踪，未来 run 自动记录当时的实际 commit。

`run --execute --raw` 在前置条件齐备后，一条命令完成预检、隔离 staging、单次提交、等待和结果回收。它没有在真实 Spectre 上演练。普通 GitHub CI 可参考 `ci/sim-static.yml.example`，只能运行离线检查。

回收的 PSFXL 仍需独立 OCEAN/CSV 科学后处理。`simulator_complete_pending_measurements` 只说明求解器成功，不能据此验收电路。MDAC LOW 的 2.017 LSB12 误差仍失败；本包不改变该结论。早期制备的 real-SAR 候选闭包已移至迁移工作目录的 `prepared-candidates/`，不属于 portable 包；正式集成采用主会话生成的 `sim/bundles/*`。
