# 电路工作台 AI 与命令行

网页 AI 面板使用与原图相同的上下文接口 `window.ICWorkbenchContext`，包括当前 Git 源、是否有未保存修改、所选器件、原始库归属及已知的层级路径。独立库快照不冒充仿真源。

本地配置为 `config/ai-client.local.json`，网关地址为 `http://127.0.0.1:8766`。运行：

```sh
python -B tools/ai/ic_workbench.py --config config/ai-client.local.json --json projects
python -B tools/ai/ic_workbench.py --config config/ai-client.local.json --json read --project-id real-sar-20261106
python -B tools/ai/ic_workbench.py --config config/ai-client.local.json --json sim-status
python -B tools/ai/ic_workbench.py --config config/ai-client.local.json mcp
```

`tools/ai/plugin.json` 与 `mcp.json` 是可安装插件包，本次没有修改全局插件安装。`tools/ai/README.md` 给出 diff、计划、执行和审批命令。工具调用复用正式网关，状态存到独立目录；不会自行启动新仿真。写操作需要页面中批准具体的差异或仿真请求。取消 AI 对话不会取消已提交的仿真。

集成验证包括8项客户端测试、12项人工确认/重放防护测试、共享上下文回归；测试使用隔离的合成输入，不能作为新电路仿真成功证据。已有三次真实仿真及其归档保持不变。
