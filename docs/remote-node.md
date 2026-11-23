# Use the online workbench with your own Codex node

在线使用：在 AI 面板填写自己的节点地址与访问码，勾选授权，选择实际工程，然后打开对话。节点首次配置一次即可；部署到自己的服务器后，日常使用不需要本地工作台。访问码不是 OpenAI API Key，网页不会自动读取订阅或导入桌面对话。原理图与波形暂时仍是 RC 示例，AI 操作的工程以节点返回的身份为准。

The [CircuitGit website](https://joshuazeng713.github.io/CircuitGit/) can connect to a **single-owner node** on your computer or your own server. The website keeps the lightweight UI; the node runs the existing Codex app-server adapter and accesses its configured circuit gateway. This is not a shared public AI hosting service.

## One-time node setup

On a computer or server you control, clone CircuitGit and prepare Python 3.10+, Git, Codex and your engineering configuration. Sign into Codex there using a supported authentication method. An existing login or provider configuration stays on that node; do not paste OpenAI credentials into the website.

Start the engineering gateway:

```bash
python3 -B tools/workbench/launch.py --port 8766
```

Then start the separate browser node:

```bash
python3 -B tools/workbench/remote_node.py \
  --gateway-url http://127.0.0.1:8766 \
  --allow-origin https://joshuazeng713.github.io \
  --port 8767
```

This prints the node address and the path to an owner-only `browser-access.key` file. The file contains a random node access code. Keep it private; it authorizes access to this node's projects and AI sessions. Starting the node does not start a model turn, submit a simulation, or change global Codex settings. `--codex-bin /absolute/path/to/codex` selects a specific installed executable.

For a previously configured AI client, use `--config /absolute/client.local.json`. The node copies its runtime settings in memory and stores its own sessions under that client's `state_dir/browser-node`; it does not modify the client configuration or reuse its conversation registry. `--state-dir /absolute/dedicated/path` overrides this location. Always choose an exclusive state directory. The node retains manual circuit approvals and does not expose developer/full-access mode.

## Connect in the browser

1. Open the online demo and find **连接你的 Codex 运行节点** in the AI panel.
2. Enter the node URL and its access code. The access code is a CircuitGit credential, not an OpenAI API Key.
3. Authorize this browser's access and click **授权并连接**.
4. Select a project returned by the node and click **打开对话**.
5. Use the existing model selector, thinking controls, image input, multi-session manager and approval UI. Check the connection from the AI panel if login or model access is unavailable.

The AI's project, source commit and saved source hash come from the node. **The RC schematic and analytical waveform demo remain separate from that remote project**; the website does not pretend its sample is your real circuit. Circuit changes and simulation requests go through the existing reviewed workflow.

Credentials remain in the current page's memory, not URLs, cookies or browser storage. Reloading the page requires reconnecting. Disconnecting closes the browser transport; it does not approve, replay or silently cancel remote work. Inspect the original session after reconnecting if a send had an uncertain outcome.

One connection binds one project. To change the project or refresh its saved source identity, disconnect and reconnect. Existing conversations stay on the node. An expired/revoked node authorization closes browser polling and requires reconnection; a model service failure leaves the affected conversation paused, with the original receipt available for inspection.

## Self-hosted HTTPS node

The node and engineering gateway both bind to `127.0.0.1`. On your server, put the browser node behind your own HTTPS reverse proxy and firewall. Keep port 8766 private. For example, with Caddy configured for a domain you control:

```caddyfile
node.example.com {
    reverse_proxy 127.0.0.1:8767
}
```

Start the node with its public address:

```bash
python3 -B tools/workbench/remote_node.py \
  --gateway-url http://127.0.0.1:8766 \
  --allow-origin https://joshuazeng713.github.io \
  --public-url https://node.example.com \
  --port 8767
```

`https://node.example.com` is the address entered on the website. A prefix such as `/circuitgit` is supported if the reverse proxy preserves it. Use one node/OS account/state directory per owner; this code does not implement multi-tenant account isolation.

The exact allowed browser origin and bearer code are checked on every request. No wildcard CORS, cookie authentication or arbitrary proxy routes are enabled. CORS trusts the entire origin, so allow only a frontend origin you trust. HTTPS is required for non-loopback nodes. Accessing a loopback node from an HTTPS website can additionally require the browser's explicit local-network permission; availability depends on the browser. A public HTTPS node avoids that local-network boundary.

To revoke browser access, stop this node and rotate its owner-only access code before restarting. Do not rotate it by exposing a new unauthenticated HTTP endpoint.

## Subscription access and scope

This release connects to the **operator's already configured Codex runtime**. It does not import desktop windows or all account conversations, implement public website OAuth, or grant model access that the node does not already have. Account and subscription metadata come from Codex; a readable model list is not proof that inference will succeed. A missing login or incompatible approval policy stops the operation.

Official references:

- [Sign in with ChatGPT: Codex app-server](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)
- [Self-hosted VM authentication](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms)
- [Hosted Sign in with ChatGPT availability](https://developers.openai.com/siwc)

Public multi-user subscription OAuth remains subject to OpenAI's hosted-integration eligibility. Do not run a shared credential pool or advertise this single-owner node as an approved hosted integration.

## Verification

`npm run test:remote` checks the HTTP authorization boundary and browser transport without invoking models. `npm run build:pages` builds the public frontend. An optional end-to-end browser check uses `NODE_URL`, `NODE_KEY_FILE`, and `NODE_PROJECT` to connect to an operator-owned test node; run `npm run test:remote:browser`. It requires Playwright and Chrome. Set `NODE_SEND=1` only to explicitly request a single read-only model message in a new test conversation. `NODE_MODEL` selects an already listed model for that test only. `FRONTEND_URL` can point at the published site; otherwise the check serves the built `site/` on `http://127.0.0.1:8790`, which must be in the node's allowed origins. Tests do not grant browser local-network permission automatically.
