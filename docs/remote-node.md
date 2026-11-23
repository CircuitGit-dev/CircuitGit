# Connect the online workbench to Codex

普通用户：启动本机连接助手 → 点击网页的 **连接本机 Codex** → 在本机弹窗确认授权 → 打开工程对话。无需理解地址和访问码。若尚未登录，由 Codex 返回官方登录页面；网页不接收账号密码或 OpenAI token。当前画布仍是 RC 示例，AI 操作的工程以助手返回的身份为准。

The [CircuitGit website](https://joshuazeng713.github.io/CircuitGit/) can connect to a **single-owner node** on your computer or your own server. The website keeps the lightweight UI; the node runs the existing Codex app-server adapter and accesses its configured circuit gateway. This is not a shared public AI hosting service.

## Recommended: local connection without an address or code

1. Install Codex, Python 3.10+ and Git. Download and unpack CircuitGit, or use an existing clone.
2. On macOS, double-click **Start CircuitGit.command** in the repository root. This opens a launcher window; keep it running. If macOS requests permission to open the downloaded script, review it and use the system's normal Open action. This is a source launcher, not a signed standalone installer, and it does not install dependencies automatically.
3. In the website AI panel, click **连接本机 Codex**. In the local popup, check the requesting website and click **允许并连接**.
4. The helper checks Codex through `account/read`. Existing login/provider settings stay in place. When Codex explicitly reports that sign-in is required, click **在官方页面登录 ChatGPT**. The URL comes from `account/login/start`; Codex owns the local callback. Wait for its correlated completion receipt.
5. Select the actual engineering project and open chat. One bundled RC engineering example is prepared by default, independently of the sample canvas.

On Linux or from a developer terminal, the same helper can be started with:

```bash
python3 -B tools/workbench/connect_browser.py
```

Windows is not supported by this source launcher yet. The current helper uses Unix file locking. Merely opening the Codex desktop app does not start CircuitGit's helper; without it, the website cannot detect Codex. There is no port scan or credential-file read. No model or account check is started before the local authorization step.

The helper uses the fixed loopback pairing address internally and starts its own engineering gateway on an OS-assigned loopback port. It leaves existing gateways untouched. Private state is under `.local/browser-helper/`; a ZIP download gets a separate Git repository for its bundled RC example inside that directory. Neither source publication nor simulation is automatic. Developers can supply `--gateway-url http://127.0.0.1:8766` to use a known existing gateway without starting another one over its runtime.

Pairing expires after three minutes, requires a one-time confirmation, and produces an eight-hour browser credential bound to the exact authorized origin. The owner key is never returned to the website. The confirmation page rejects framing; messages must match the opened window, origin and request state. Browser credentials remain in page memory. Stopping the helper revokes its in-memory pairings. Reloading requires a new confirmation.

## Advanced: manual node setup

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

1. Open **高级：连接自己的服务器** in the AI panel.
2. Enter the node URL and its access code. The access code is a CircuitGit credential, not an OpenAI API Key.
3. Authorize this browser's access and click **授权并连接**.
4. Select a project returned by the node and click **打开对话**.
5. Use the existing model selector, thinking controls, image input, multi-session manager and approval UI. Check the connection from the AI panel if login or model access is unavailable.

The AI's project, source commit and saved source hash come from the node. **The RC schematic and analytical waveform demo remain separate from that remote project**; the website does not pretend its sample is your real circuit. Circuit changes and simulation requests go through the existing reviewed workflow.

Credentials remain in the current page's memory, not URLs, cookies or browser storage. Reloading the page requires reconnecting. Disconnecting closes browser polling. The existing adapter pauses an active AI turn after its browser heartbeat has been absent for 20 seconds; this does not cancel an already submitted simulation or automatically approve/replay an operation. Inspect the original session receipt after reconnecting, especially if a send had an uncertain outcome.

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

This release connects to the **operator's Codex runtime**, with an explicit official app-server browser login option for locally paired clients. It does not import desktop windows or all account conversations, implement public website OAuth, or grant model access independently of Codex. Account and subscription metadata come from Codex; custom providers may not report a subscription, and a readable model list is not proof of inference access. No login/provider is silently replaced. Remote owner access codes cannot initiate the local account login flow.

Official references:

- [Sign in with ChatGPT: Codex app-server](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)
- [Self-hosted VM authentication](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms)
- [Hosted Sign in with ChatGPT availability](https://developers.openai.com/siwc)
- [Website OAuth registration and backend requirements](https://developers.openai.com/siwc/website)
- [Codex app-server account and browser-login protocol](https://learn.chatgpt.com/docs/app-server)

Public multi-user subscription OAuth remains subject to OpenAI's hosted-integration eligibility. Do not run a shared credential pool or advertise this single-owner node as an approved hosted integration.

## Verification

`npm run test:remote` checks the HTTP authorization boundary and browser transport without invoking models. `npm run build:pages` builds the public frontend. An optional end-to-end browser check uses `NODE_URL`, `NODE_KEY_FILE`, and `NODE_PROJECT` to connect to an operator-owned test node; run `npm run test:remote:browser`. It requires Playwright and Chrome. Set `NODE_SEND=1` only to explicitly request a single read-only model message in a new test conversation. `NODE_MODEL` selects an already listed model for that test only. `FRONTEND_URL` can point at the published site; otherwise the check serves the built `site/` on `http://127.0.0.1:8790`, which must be in the node's allowed origins. Tests do not grant browser local-network permission automatically.

Use `NODE_PAIR=1` instead of URL/key variables to verify the default local flow. It tests cancellation before any account/project read, then confirms a real popup and checks connection. Official sign-in state/URL/correlation are tested with a fake app-server; the test suite never signs a real account out or submits account credentials.
