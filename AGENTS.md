# AGENTS.md（7shell 仓库级代理与贡献者指令）

本仓由多会话并行开发（多工作树 + 子代理车道），AI 代理与人类贡献者共用一套流程。开始任何改动前，按顺序读：

1. **改代码前先读 [`docs/LESSONS.md`](docs/LESSONS.md)**——教训账本，每条都是带证据的复发规则；Seen 满 3 天的规则固化进 [`docs/规范/编码与验收标准.md`](docs/规范/编码与验收标准.md)，审查与收口逐条对照。
2. **跑任何长构建命令前先过并行登记**——`cargo build/test`、`pnpm install/check`、`tauri build`、`make app-e2e` 这类吃内存的命令，先 `python C:/Users/USER/.zcode/cli/parallel_tasks.py check` → 有活跃任务先 `register --name <任务名> --sandbox <独立沙盒>`，跑完 `done --name <任务名>`（禁裸 `done`，会注销全部活跃任务）。构建并发上限 2 路，瓶颈是内存提交量不是 CPU。
3. 定向测试纪律、验收清单（含 not run 条款）、派活模板：[`docs/开发流程-派活与验收清单.md`](docs/开发流程-派活与验收清单.md)。
4. 架构与不变量：[`docs/architecture.md`](docs/architecture.md) 与 [`docs/security-model.md`](docs/security-model.md)。改契约必须同批更新归属文档；动 security-model 不变量先走 [`docs/pips/`](docs/pips/README.md)。
5. 文档写现状，提案写进 `docs/pips/`（门槛见其 README）；新缺陷/教训在收口后补记 `docs/LESSONS.md`（规则一句话 + hash 证据 + Seen 计数，不写流水账；事件叙事进 `docs/经验总结/`）。
6. **「提交即回填」**：用户可感改动随提交回填 `CHANGELOG.md` 的 `[Unreleased]` 段（一句一条，带提交哈希）。
7. **对外动作须用户明确授权**：push 任何远端、建 tag、发 release、外发内容均不得自动执行。
8. **推送 GitHub 一律走令牌**，禁裸 `git push`（裸推走 credential.helper 指向的 GUI 凭据管理器，弹窗抢焦点且可能常驻不退）。令牌读 `.local/github-token.json`，命令行加 `-c credential.helper=` 置空凭据助手再推；推送脚本仓名写死、回显目标 URL、注释纯 ASCII。
9. 人类贡献者面向的流程（环境搭建、提交规范、依赖门槛）见 [`CONTRIBUTING.md`](CONTRIBUTING.md)；本文件只管代理协作纪律，两者冲突时以更严格者为准。
