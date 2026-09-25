# Lily 中文说明

> 产品主页见 [README](README.md)。本文是面向中文读者的技术说明：安装使用、执行环境、研究用法与代码结构。

Lily 是一个在终端里使用的 coding agent（和 `pi`、Claude Code 一样：装好后在项目目录里输入 `lily` 即可）。它的内核（agent loop、read/bash/edit/write 四个工具、会话、压缩）直接复用 Pi agent 0.85.1；在此之上，Lily 让**每个 run 的工具都在隔离环境里执行**（从 macOS Seatbelt 沙箱到每个环境一个轻量虚拟机），把影响 agent 行为的资源（附加提示、记忆、技能、工具说明、观测处理器）做成**不可变的资源包**并在 run 开始前固定，并**完整记录**每个 run（真实的模型输入输出、格式化之前的原始工具输出、vLLM 的 token id）。

所以同一个 harness 既是日常可用的 coding agent，也是研究/后训练用的干净轨迹生成器。Lily 只提供机制：数据集、评测/打分、资源包的搜索与路由策略、训练框架适配都在下游，由下游适配 Lily 的通用接口（TypeScript SDK、`lily -p --json`、HTTP API）。

- 使用文档：[getting-started](docs/getting-started.md) · [TUI](docs/tui.md) · [配置](docs/configuration.md) · [执行环境与平台兼容性](docs/environments.md) · [程序化使用 / SDK](docs/sdk.md) · [HTTP API](docs/api.md)
- 格式：[资源包](docs/bundle-format.md) · [轨迹 lily.traj/v1](docs/trajectory-format.md) · [envd 协议](docs/envd-protocol.md)
- 工程：[架构](docs/architecture.md) · [计划与进度](docs/PLAN.md) · [设计决策](docs/decisions.md) · [变更记录](CHANGELOG.md)
- 发布页：[`site/`](site/)（静态网站：产品介绍、真实 TUI 录制的演示、文档、安装命令）

## 安装与使用

需要 Node.js ≥ 22.19（macOS 或 Linux）。

```bash
npm install -g lily-harness
cd my-project
lily --script demo      # 离线体验（内置脚本模型，不需要 API key）
```

接入真实模型：

```bash
export ANTHROPIC_API_KEY=...          # 或 OPENAI_API_KEY、GEMINI_API_KEY、OPENROUTER_API_KEY、DEEPSEEK_API_KEY 等
lily                                  # 没有可用模型时会进入首次设置界面，选择后保存为默认
lily -c                               # 继续当前目录最近的会话
lily -p "修复失败的测试"                # 单次运行，答案输出到 stdout；加 --json 输出逐行 JSON 事件
```

自托管模型（vLLM / SGLang 等 OpenAI 兼容服务）写进 `~/.lily/config.json`，见 [configuration.md](docs/configuration.md#self-hosted-models)；配置 `tokenCapture: "vllm"` 后记录可达 token 级精确。

TUI 里：直接输入并回车；agent 工作时再次输入即为插话（steer，模型在下一轮看到）；Esc 取消当前 run；`/model` `/resume` `/tree` `/thinking` `/bundle` 等打开交互式选择器；`/help` 查看全部命令与快捷键（[tui.md](docs/tui.md)）。

## 执行环境

每个 run 的四个工具都通过 guest agent `lily-envd` 在独立环境中执行，宿主环境变量（包括 API key）从不进入环境。

| backend | 隔离档位 | 平台 | 实测 |
|---|---|---|---|
| `local` | 无 | macOS / Linux（仅开发调试；Linux 上的默认值） | ✅ |
| `seatbelt` | 进程沙箱 | macOS（macOS 上的默认值） | ✅ macOS 26 |
| `apple-container` | 虚拟机（每个环境独立 Linux 内核） | macOS 26+（15 有限制），Apple silicon | ✅ M4 / macOS 26.7 |
| `docker` / `podman` | 容器（共享宿主内核） | Linux（cgroup v2）；macOS 上经 Docker Desktop 等 | ✅ Linux arm64 |
| `gvisor` | 用户态内核 | Linux（docker/podman + runsc，不需要 KVM） | ✅ Linux arm64 |
| `firecracker` | microVM | Linux + KVM | ✅ Linux arm64（嵌套虚拟化） |

```bash
lily env backends                                  # 查看本机可用的 backend
lily config environment '{"backend":"apple-container","image":"docker.m.daocloud.io/library/python:3.12-slim"}'
```

各系统在开/关虚拟机隔离时的兼容性与验证状态见 [environments.md](docs/environments.md)。

## 研究用法（通用接口）

```bash
lily -p "Fix the failing test" --json --copy --bundle base --label task=t1 > events.jsonl   # 任意语言都能驱动
lily runs && lily show <run> && lily export <run> --raw -o run.traj.json
lily annotate <run> check '{"passed": true}'                                               # 下游把自己的结果挂到 run 上
lily bundle import ./my-bundle --ref v2 --parent base                                     # 派生资源包（来源信息自由格式）
lily bundle compose --from base --part M=v2 --part S=v2 --ref mixed                      # 按组件组合
lily --router ./my-router.mjs --bundle @router --label group=bugfix                      # 多个资源包共存，由外部 router 按 run 选择
lily serve                                                                               # 本地 HTTP API（docs/api.md）
```

TypeScript 下游直接用 SDK：`import { LilyRuntime, renderCallView } from "lily-harness"`。[examples/sdk/rollout.ts](examples/sdk/rollout.ts) 演示了下游如何只用公开接口实现并发 rollout、结果检查与注解（带测试）。接口说明见 [sdk.md](docs/sdk.md)。

与方法设计的对应关系（机制在 Lily，策略在下游）：

- **固定内核 K**：工具 schema/描述/参数准备取自 Pi 0.85.1；系统提示词组装、压缩、会话、权限不在资源包中；资源包只含 `prompt/ tools/ skills/ memory/ observation/` 五个组件。
- **run 内资源固定**：manifest 在第一次模型调用前写出（内核版本、模型、资源包及五个组件摘要、系统提示词分块、观测处理器、环境、预算、labels、路由决定）。
- **o = F(z)**：工具先产生原始结果 z 并归档，再由 F（声明式 DSL）生成观测；默认 F 与 Pi 原生输出逐字节一致。`renderCallView()` 可以在不执行任何工具的前提下，用其他资源包的提示块与处理器重渲染某次调用的上下文（例如下游构造评分视图）。
- **多资源包共存**：注册表 + `@router` 钩子；如何路由、如何扩张/收缩资源包集合由下游 router 决定。
- **结果未知不盲重跑**：工具执行前持久写 dispatched；重启后已完成的结果从账本取回，结果未知的 run 进入 `blocked`/`interrupted`。

## 从源码开发

需要 Node.js ≥ 22.19；构建 guest agent 需要 Go ≥ 1.26（版本以 [envd/go.mod](envd/go.mod) 为准）。

```bash
git clone https://github.com/Saito-Karuha/Lily.git
```

```bash
cd Lily
```

```bash
npm ci
```

```bash
npm run build:envd
```

源码目录中直接运行 TypeScript 源码，离线体验无需 API key：

```bash
node bin/lily.mjs --script demo
```

开发检查（不可用的 backend 测试会自动跳过）：

```bash
npm test
```

```bash
npm run typecheck
```

```bash
(cd envd && go test ./...)
```

只生成本地 npm 包、不对外发布（prepack 会编译 dist/lib 与 envd）：

```bash
npm pack
```

目录：

```
bin/lily.mjs       CLI 入口（源码目录跑 src/，安装后跑 dist/lib）
src/kernel/        固定内核：工具（raw 执行器 + Pi 等价基线）、执行网关与账本、系统提示词组装
src/env/           envd 客户端、Pi ExecutionEnv 适配、环境管理器与各 backend
src/resources/     资源包格式/校验、不可变注册表、渲染、观测处理器 DSL、router 钩子
src/models/        模型注册（pi-ai）、逐调用记录网关、vLLM token 捕获
src/runtime/       会话 worker（Pi AgentHarness）、run manifest、事件
src/trajectory/    lily.traj/v1 导出、调用视图重渲染、markdown 渲染
src/server/ src/cli/   HTTP API、CLI 与 TUI；src/index.ts 为 SDK 入口
envd/              lily-envd（Go，静态二进制）
examples/          示例资源包、离线脚本、router 示例、SDK 下游示例与示例任务
site/              发布页（静态网站）
test/              unit / integration / isolation / tui 测试
docs/              文档
```

## 已知限制

- worker 重启后不会重新接管仍存活的容器/虚拟机环境，未完成的 run 记为 `interrupted`（D6）。
- Seatbelt 档位下 agent 看到的是真实宿主路径；需要所有 agent 视图一致时请用虚拟机档位。
- `token_exact` 依赖推理服务返回 token id（目前适配 vLLM）；商用 API 最高为 `request_exact`。
- 各 backend 的实测状态见 [environments.md](docs/environments.md)。
