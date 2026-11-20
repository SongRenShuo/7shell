# Linux 桌面五期：Semi Design 视觉重构 + Docker 管理器对齐 fnOS — 开发计划（立项）

> 2026-11-19 立项，基线 `desktop-fnos-iteration`（tip `1420da4`，含四期全部工作与远端批次七/八/九开篇）。
> 目标用户口径：**「引入 Semi Design 重构 Linux 桌面的 UI，重点丰富 Docker 管理器的功能，主要功能模块参考飞牛来设计」**。
> 输入材料：[fnOS UI 精华拆解-调研报告](../调研报告/20261119-0302-fnosUI精华拆解-调研报告.md)（Semi 令牌实测值/桌面形态/Docker 深潜 §G）、[四期计划](20261119-0302-linux桌面四期fnOS体验对标-开发计划.md)（既有裁定与双模式基础）。
> **与四期裁定的关系**：四期记录的「不引 Semi、不换品牌色」（四期计划 §一第 6 条、§二裁定表、§十一）经用户显式改向**部分作废**——本五期重新裁定并在四期计划顶部加指针；其余裁定（不做第二套组件运行时、影响面锁死、验收五件套）继续有效。

## 一、最高技术决策：Semi Design 只有 React 版（先读这里）

**事实（2026-11-19 核实）**：Semi Design（抖音 douyinfe/semi-ui）官方仅提供 **React** 实现；官方 Issue #56 明确 Vue 版优先级低、依赖社区移植，无官方 Vue 3 包。7shell 前端是 Vue 3 + Tailwind v4，全应用约 117 个 .vue。

| 路线 | 内容 | 判定 |
|---|---|---|
| **A：Semi 设计系统落地（推荐）** | 引入 **Semi 的令牌体系与视觉规范**（`--semi-*` CSS 变量层 + 组件视觉规格），把桌面域的自研组件（WbButton/WbTag/WbEmpty/对话框/菜单/表格/任务栏/启动器）按 Semi 视觉**重皮**；零新运行时依赖，Vue 栈不动 | **采用** |
| B：社区 Vue 移植 | semi-ui-vue 等非官方包：不成熟、停更风险、与 Tailwind v4 体系冲突、i18n/主题体系不合 | 否 |
| C：桌面域换 React | 推翻全应用架构（SPA 是 Vue），代价不可接受 | 否 |

**为什么 A 成立**：fnOS 自己就是「React + Semi + Tailwind 混用」，其视觉来自 `--semi-color-*` 令牌层——而令牌层是纯 CSS 变量，与框架无关。我们在四期已把 fnOS 的 Semi 令牌实测值全部提取（品牌蓝 `--semi-brand-5: 0,102,255`、语义三态浅底、时长 90ms/.12s/.18s、阴影三档），落地为 `--workbench-*`。五期要做的是**把令牌层升级为 Semi 命名法 + 按 Semi 规范重皮组件**，即「Semi 化的自研组件库」，而不是引 React 库。
**决策点 D1（已按推荐裁定）**：采用路线 A。若坚持「运行时真 Semi」，等价于路线 C 立项，需单独立项评审。

**决策点 D2（推荐，形态评审门确认）**：桌面域品牌色从 teal 切换为 **fnOS/Semi 品牌蓝 `#0066FF`**（跟随"参考飞牛"的口径）；应用域（桌面之外的界面）保持现状不动。菜单/激活条/焦点环/选中态随之变蓝。
**决策点 D3（推荐，形态评审门确认）**：窗口内容面板改 Semi 面板视觉（实底 + `--semi-shadow-app` + 1px 描边）；桌面 chrome（任务栏/启动器/壁纸之上的玻璃）保留毛玻璃但色值全部走 Semi 令牌。

## 二、Docker 管理器对照 v2（2026-11-20 复分析；初版对照见 git 历史）

fnOS Docker = 独立子应用，左导航六页签 + 服务设置；7shell 现状 = 桌面窗口内 `ContainerPane` 双模式（desktop：概览/容器/镜像三页签 + 创建向导），引擎 24+ 命令（含 inspect/stats/exec/日志流/镜像全操作/registry 登录/命名空间），已有 `ContainerDetailDrawer`/`ImageDetailDrawer`/`ImageTaskPanel`/`RegistryLoginDialog`/`ContainerWizard`。

### 2.1 模块对照

| fnOS 模块 | 7shell 现状（含五期在途） | 引擎 | 批次 |
|---|---|---|---|
| 概览（摘要+实时图+健康灯） | ✅（四期+五期 Semi 化+蓝曲线） | stats ✅ | 已收口 |
| 容器列表（9 态/更多菜单/搜索/斑马纹） | ✅（四期+五期 Semi 化） | ✅ | 已收口 |
| **创建容器向导**（三步分区卡） | ✅ 完整接线（lane W 三步卡 + lane S2 七字段上盘 3b86ae5；「未接线」chip 全摘） | ✅ | 已收口 |
| 容器操作（启停/重启/删除/改名） | ✅ | ✅ | — |
| 容器终端 / 日志流 / 容器文件 | ✅ | ✅ | — |
| **容器详情**（fnOS「详情」= inspect 结构化信息概览） | ⚠️ DetailDrawer 已有，字段完整度待比对 inspect 全量 | inspect ✅ | 七 |
| **复制容器**（默认不启动） | ❌ | inspect+create 组合（UI 层） | 七 |
| **按容器实时监控**（fnOS：每容器 CPU/内存/网络三图） | ❌（概览只有聚合图） | container_stats 按容器 ✅ | 七 |
| **容器日志页**（fnOS：/logs 页 + 错误日志分离 + 空态） | ⚠️ 日志流有；错误分离/独立日志页形态 ❌ | ✅ | 七 |
| **镜像更新流**（5 步确认/防重复/「请先关闭容器」清单弹窗） | ✅（更新流 + 5 步确认 + 防重复；直连不可达宿主按能力位降级为手动 pull） | pull/history ✅ | 已收口 |
| **镜像仓库**（加速源/代理） | ✅ 只读卡片（加速源/代理 + 建议片段只复制不写盘） | `docker info` 只读 | 已收口 |
| **Compose 项目** | ✅（引擎 aa361c4 + 前端页 a5db83b：项目列表/创建向导/日志窗/能力位降级） | ✅ | 已收口 |
| **网络** | ✅（引擎 aa361c4 + 前端页 a5db83b：列表/新建表单/护栏弹窗） | ✅ | 已收口 |
| 服务设置（开关/存储迁移） | ❌ | systemd 通道 | 不做（§八） |

### 2.2 UI 规律对照（fnOS §G9 逐条核对）

| fnOS 规律 | 7shell | 批次 |
|---|---|---|
| 页面容器 min-w-[850px] + 内容 p-5/gap-3 | ⚠️ 桌面窗口可缩至 200px，表格挤压无横滚 | 七 |
| 页头 = text-lg bold + 300px 搜索 + primary 主操作 | ✅（lane U） | 已收口 |
| 状态 tag 浅底深字 | ✅（WbTag） | 已收口 |
| 表单分区卡 + 行式增删 + 行内校验 | ✅（wizard） | 已收口 |
| **loading 态文案枚举**（fnOS 11 种：starting/stopping/…） | ⚠️ 部分（start/stop 有；pulling/removing/restarting 枚举不全） | 七 |
| 弹窗宽档 682px | ✅（wizard 42.5rem） | 已收口 |
| 错误码→中文全量映射 | ✅ 机制（需随网络/Compose 扩展补码） | 三/四随行 |
| 图表禁动画 + tooltip 统一 | ✅（自绘 SVG 禁动画） | 已收口 |

## 三、视觉重构范围（Semi 化清单）

1. **令牌层**：`globals.css` 新增 `--semi-*` 桥接层（品牌蓝 0-9 阶、语义色三态浅底、灰阶 0-9 明暗反转、圆角 6px 控件、阴影三档、时长三档）——`--workbench-*` 从 `--semi-*` 派生，**一套事实源、两层命名**，避免双体系漂移；亮暗用现有 `.dark`/`:root` 翻转（fnOS 的 `theme-mode` 同构）。
2. **组件重皮**：WbButton（primary=品牌蓝/secondary 白底描边/tertiary/warn + sm/md/lg + loading 态）、WbTag（浅底深字三态）、WbEmpty（Semi 插画风格重绘或保留现五场景）、`ConfirmDialog`/`DialogRoot` 组合、`ContextMenu`（teal→Semi dropdown 视觉）、`lib/table.ts` 表格（hover/选中/斑马纹/列分隔线，对齐 fnOS trim-ui 表格）。
3. **桌面 chrome**：任务栏/启动器/通知面板/小部件色值全部接 `--semi-*`；窗口铬毛玻璃保留（D3）。
4. **字体**：正文 14px/22px 对齐 Semi 规格；守卫（typography）如冲突先修订契约。
5. **范围锁死**：Semi 化只作用于桌面域；应用级界面与 `ContainerPane` 的 `flat` 模式保持现状。

## 四、批次划分

### 批次一：Semi 令牌层 + 桌面 chrome 重构（视觉地基）

- **形态评审门（先于一切落码，LESSONS I26）**：出预览 PNG（现状 vs Semi 化，暗/亮双版 + 蓝色 accent 对照）交用户确认 D2/D3 后才动代码。
- 内容：§三全部；四期计划改向指针回填。
- 验收：桌面域字面色 grep 归零（token 层除外）；既有 spec 探针改断言目标后全绿；亮暗双主题走查记录；i18n 守卫绿。

### 批次二：Docker 页 Semi 化 + 创建容器向导

- 内容：概览/容器/镜像/日志/终端/文件六面全部换 Semi 视觉；**创建容器向导**（分步：基本设置→高级设置分区卡→确认信息；端口/存储/环境变量/网络多选/capabilities/命令/CPU 权重+内存限制行式增删，行内校验）；错误码→人话映射随行。
- 验收：真机对无状态测试容器走创建→启动→日志→终端→删除全链路；向导每步 spec；应用级 flat 模式零 diff 复核。

### 批次三：引擎网络管理 + 网络页

- 车道 R（Rust）：`network_list/inspect/create/rm` 固定动词（`docker network ls/inspect/create/rm --format json`），policy：create/rm = Caution，rm 关联容器>0 = 拒绝（护栏在引擎）；web/tauri 双宿主 + live 测试（ignored）。
- 车道 S（前端）：Semi 视觉网络页（列表列：名称/驱动/子网/网关/IPv6/关联容器数；新增表单 CIDR 校验；删除护栏文案）。
- 验收：真机建删测试网络（自建 `mem-net-test`，验后清理）；护栏反向验证（摘引擎拒绝 → 红）。

### 批次四：Compose 项目管理

- 车道 R：`compose_ls/ps/up/down/restart/logs` 固定动词（`docker compose -p <name> ...`，yml 经既有文件通道写入指定目录），`desktop_engine_open` 时探测 `docker compose version` 存能力位；policy：up/down = Caution，down 含数据提示。
- 车道 S：Semi 视觉 Compose 页（项目列表/状态 tag/创建向导：名称规则+目录选择+yml 文本域（缩进校验，不引编辑器库）+「创建后立即启动」开关/日志窗/运行时配置只读提示）。
- 验收：真机建测试项目（nginx 单服务）→ 启动→日志→停止→删除，全链路；无 compose 插件的宿主只露概览（fnOS 语义）。

### 批次五：镜像更新流 + 镜像仓库设置（只读）+ 复制容器（可选）

- 更新镜像流：tag 比对「有新版本」徽标 → **5 步确认清单弹窗**（停容器/数据风险/加速源/不可取消/失败补救）→ pull → 防重复（错误码映射）。
- 镜像仓库：只读展示当前加速源/代理（`docker info` 解析）+ 建议配置片段复制；**写 daemon.json 不做**（红线，见 §八）。
- 复制容器（可选）：inspect → create 预填向导，默认不启动。
- 验收：真机对无状态测试镜像走更新流；5 步确认每步可单独取消。

### 批次六：收口

- 两轮真机走查（含视觉对照截图）、全量门禁、NSIS+哈希、CHANGELOG 回填、本文件记录回填、MEMORY 索引、四期/五期裁定一致性复核。

## 五、车道契约总则

- 车道 R（Rust 引擎+双宿主+契约桥）与车道 S（前端桌面域）分列；**前端不改 WorkbenchPane 结构性代码**（门接入归主控）；`ContainerPane` 双模式延续。
- 每批冲突→单独分支和工作树；主控合并并清理；决策点按推荐执行并记录；真机 103.36.220.245 **只读 + 自建一次性资源**，禁碰 13 个用户容器。
- 提交纪律：每单元即提交、`commit -F` UTF-8、每提交过编译/定向测试；并行登记 `parallel_tasks.py`。

## 六、验收清单（每批过一遍）

- [ ] `pnpm check` 15 步全绿 + `cargo fmt/clippy -D warnings/test --workspace` + `cargo deny`
- [ ] 真机读数回填批次小节（带命令与数字）
- [ ] CHANGELOG `[Unreleased]` 按提交回填
- [ ] NSIS 重建 + 哈希记录
- [ ] 新增界面无 disabled 占位；i18n en+zh 双语
- [ ] **影响面复核**：应用级界面零 diff；`ContainerPane` flat 走查一致；Semi 令牌层只挂桌面域
- [ ] 吸收纪律复核：零新运行时依赖（路线 A）、单一令牌事实源、无双组件运行时

## 七、风险

1. **Semi React/Vue 事实**：路线 A 规避；若用户坚持运行时 Semi → 路线 C 单独立项。
2. **双令牌漂移**：`--semi-*`（新事实源）→ `--workbench-*`（派生）单向依赖，禁止反向写值；桥接层加注释与守卫说明。
3. **品牌色争议**：teal→蓝是显式视觉改向，形态评审门出对照图确认（I26）。
4. **compose CLI 差异**：真机 v5.7.1 在；探测失败只露概览，不崩。
5. **daemon.json 侵入红线**：仓库既有裁定「命令不上机」——只读展示 + 建议片段，写操作不做。
6. **长规格文件**：向导/Compose 页表单多，i18n 键量大（预计 +120 键），check:i18n 每步过。
7. **E 盘满盘**：构建沿用 `CARGO_TARGET_DIR=D:\HuanJing\7shell-target`。

## 八、不做（五期主动裁剪）

- 路线 B（社区 Vue 移植）/路线 C（桌面域 React 化）；Semi 运行时库引入；写 daemon.json/重启 docker 自动化（只读+建议）；Docker 卷管理页（fnOS 六页签无卷，对齐）；服务开关/存储迁移（侵入）；40px 超圆弹窗；全局禁用右键；应用级界面 Semi 化。

## 九、与既有文档的冲突处理（同批更新）

- 四期计划 §一第 6 条/§二/§十一的「不引 Semi/不换品牌色」→ 顶部加「五期改向指针」，原文保留不删（历史账）。
- `docs/ui-conventions.md`：若 Semi 字号/交互规格与「四档字号」宪法冲突，批次一先修订契约再落码（宪法修订不是违反）。
- `docs/architecture.md`：桌面域不变量不受影响（令牌层是前端事）；如 lane 变更触及再补。

## 十、批次实施记录（实施后逐批回填）

### 批次一（Semi 令牌层 + chrome 重构）

- 实施车道：车道 T（令牌层+chrome，工作树 lane-semi-t）+ 车道 U（窗口铬+Docker 页+基础件，工作树 lane-semi-u）并行；主控合并（f5000b2/c7bb3f6，零冲突）+ 令牌协调（b7b181a：`--workbench-panel` 实底面板、`--workbench-success`、壁纸之上恢复 blur）。
- 形态评审：**通过**（2026-11-20 用户「通过」）。预览图存档 `assets/20261120-Semi视觉预览/`（暗色全景/暗色 Docker/亮色对照；初版亮色全屏截图系切换瞬间的陈旧帧，裁剪复核证明亮色正确，已换图 d7ed879）。
- 读数：车道 T 138 例 + 车道 U 1305 例（宽回归）+ 合并后桌面域 551 例 + 收口门禁 **15/15 全绿**（rust tests 651.2s、supply chain 66.8s）；反向验证：T 摘 `--semi-brand-5` 守卫红、U 摘 WbTag 映射红，均成对还原。
- 用户报障修复（本批次内）：显示桌面按钮空桌面死点击 → 空态禁用+tooltip（755962d）。
- 遗留：亮色桌面门标签对比度可再抬一档（非阻塞，随批次七走查复核）。

### 批次二（Docker 页 Semi 化 + 创建向导）

- 车道 U（Semi 化：SideNav/概览/镜像/容器列表 desktop 分支 + flat 零 diff 守卫）已随批次一合并；创建向导由车道 W 交付并合并（9da07a3）：三步分区卡、行式增删、行内校验、创建后启动 diff 逻辑、21 例 spec、i18n 51 键 ×2。
- 引擎 7 字段扩展（privileged/capabilities/networks/内存/CPU 权重/labels/volume 只读）由车道 R 在途——落地后向导摘「未接线」警示 chip（接线属批次七前收尾）。

### 批次三（网络管理）

- **引擎半场（lane R 交付，合并 aa361c4，零冲突）**：`network_list/inspect/create/rm` 固定动词 web+tauri 双宿主；护栏在引擎（rm 关联容器 >0 = `CONTAINER-NETWORK-IN-USE` 拒绝）；policy `container.network-create/remove` Caution；桥 `backend.dockerNetworks.{list,create,remove}`；能力位 `ContainerRuntimeInfo.networkAvailable?`。
- 读数：container 160 例（含护栏正反例、逐字段映射）+ core lib 215 + policy 45 + contracts 25/25 + errors 11/11 + i18n 1689 键双语 + clippy 绿；真机 23.1s——list 4 行、自建 mem-net-test（172.62.0.0/24）、**护栏真机反向**（nginx 临时容器挂网 rm 被拒 → 摘容器后 rm 成功），零残留。
- **前端半场（lane S2 交付，合并 a5db83b，零冲突）**：DockerNetworks 页（Semi 列表：名称/驱动/子网/网关/IPv6/关联容器数 + 300px 搜索 + 新建表单 CIDR/网关行内校验 + ConfirmDialog 护栏 + IN-USE 句子上页面条）；能力位降级判断在 `ContainerPane.vue:124/:127`（缺席按 true、false 裁行）；errors.spec DOCKER_SURFACE 补 `CONTAINER-NETWORK-IN-USE`。**只手动刷新**（spec 断言挂载后 120ms 仍只读一次）。
- 批次读数：新增/更新 spec 92 例，容器域整体 15 文件 **160 例全绿**；check:i18n **1764 键**双语（基线 1729 → +35，实际用量见批次四）；`pnpm check --skip=rust` 11/11（本车道零 Rust 改动，cargo 门禁归主控合并验证）。
- 真机（S2，只读 + 自建自清）：建网 200ms rc 0、inspect 回读字段一一对应；护栏真机复现（挂容器 rm 被 daemon 拒「has active endpoints」）；摘容器后 rm rc 0；`grep -c mem-net` 0 零残留。
- 遗留：批次六收口的两轮真机走查对网络页/Compose 页做一次带截图的人工核对（CIDR 行内报错文案、日志窗 pause 行为）。

### 批次四（Compose 项目）

- **引擎半场（lane R 交付，同 aa361c4）**：`compose_ls/ps/up/down/restart/logs_start/write_yaml` 固定动词双宿主；yml 经既有文件通道写盘；`desktop_engine_open` 探测 `docker compose version` 落能力位 `composeAvailable?`（缺席宿主按 fnOS 语义裁页签只露概览）；policy up/down/restart/writeYaml Caution（down 文案含数据提示）；compose 日志/附着 up 复用 `onStreamLine/onStreamEnd` 既有流通道。
- 读数：compose 单测 10 例 + 过滤 14 例；真机 38.8s——插件 v5.7.1 在，yml 写盘 → detach up → ps running → ls 折叠 services=1/containers=1 → logs 跟流 31 行 → down 后项目消失 → 目录清理；无文件 `compose -p <name> restart` 真机 exit 0；desktop_docker 回归 13 容器/13 stats/50 日志行 25.9s；零残留。
- 已知边界：`compose ls --all/--format json`、`ps --all` 依赖插件 ≥v2.2 语义，老插件宿主报错即裁页签（fnOS 降级语义）；up 非 detach 为流式跟随，停流不保证容器行为（文档随前端页注明）。
- **前端半场（lane S2 交付，同 a5db83b）**：DockerCompose 页——项目列表（状态 tag 四档色调 + 服务/容器折叠计数）、创建向导（名称规则对齐引擎校验、绝对路径目录、yml 文本域轻量缩进解析 **零编辑器库**、创建后立即启动开关 → writeYaml + detach up）、restart/down/up 走 Caution 确认（down 文案含「停止并被移除」）、日志窗按 streamId 路由复用 onStreamLine/onStreamEnd（pause 保留 backlog，关闭即 streamStop）；`composeAvailable=false` 只露概览（fnOS 降级语义）。
- i18n 实际用量：网络页 27 + Compose 页 36 + 向导 labels 4 − 摘除 remark/notWired/reviewSkipped 8 + rail 2×2 = 净 +35 键（风险表预估 +120 过高，实际更省）。
- 批次状态：**已收口**（引擎+前端+真机护栏复现 + zero 残留；带截图人工核对项并入批次六收口清单）。

### 批次五（镜像更新流 + 仓库设置）

- **交付**（车道 S3，三任接力；提交 `ff5e60e` 引擎两读动词 → `e87ec1f` 仓库卡片 → `c1a81d9` 更新流 → `a66279a` fmt 基线修复 → `ba903c6` clippy 两处守卫；主控合并 `ddb2bc7`，合并后类型修补 `b0e6fcc`）。
- 引擎：`docker_info`（只读：`RegistryConfig.Mirrors` + `HttpProxy/HttpsProxy/NoProxy`）+ `image_remote_digest`（候选链 **`buildx imagetools inspect` → `manifest inspect --verbose`**，失败落能力位 `manifestInspectAvailable?`）；镜像引用经加速源改写（`docker.gmssh.com/library/<repo>`，加速源只对 Docker Hub 语义生效）。
- 前端：镜像行「检查更新」→ 徽标；**5 步确认清单**（受影响容器 / 数据风险 / 当前加速源 / 不可取消+防重复 / 失败补救，每步可单独取消）→ 既有 pull 流；「镜像仓库」只读卡片（加速源 + 代理 + 建议 daemon.json 片段**只复制不写盘**）落**镜像页**（协调后避开 DockerOverview）。
- **真机读数（103.36.220.245，Docker 29.9.3）**：
  - `docker info --format '{{json .}}'` 字段核实：`RegistryConfig.Mirrors` = 6 条带尾斜杠的加速源 URL；`HttpProxy/HttpsProxy/NoProxy` 均为空串（键名首字母大写 H，车道解析正确）。
  - **直连探测全超时**：`buildx imagetools inspect busybox:1.37` 与 `manifest inspect --verbose busybox:1.37` 打 registry-1.docker.io 均 i/o timeout——加速源只作用于 daemon 的 pull，不作用于这两个探测命令；此宿主因此走**能力位 false 降级**（前端只留手动 pull），正是设计预期的真实场景。
  - **经加速源探测成立**：`docker.gmssh.com/library/busybox:1.37` → imagetools 直出 `Digest: sha256:a7dbc319b1438115a207e11930dc4bb3e643dcb3ec0bdd694bb36cd8fad289ec`，与本地 `RepoDigests` 完全一致 → **「已是最新」比较路径真机跑通**；`manifest inspect --verbose` 对 index 给的是平台子 manifest digest（`66a6306…` ≠ pull digest），解析器对数组返回 None（不会误报有新版本）。
  - 零残留复核：13 个用户容器未动、零测试网络、零 compose 目录。
- 门禁：Rust **581 例全绿**（container/types/error/policy/core/web）+ clippy `-D warnings` 干净 + `cargo fmt --all --check` 干净（含车道 R 遗留的 9 处基线红，本车道修复）；前端容器域 + 桥 + 契约 **221 例**；i18n **1810 键**双语；typecheck 净。
- 遗留：直连不可达的宿主上更新流只到「手动 pull」，与 fnOS 的加速源语义一致；若后续要探测经加速源自动改写，需先确认 `manifest`/`imagetools` 是否接受镜像名前缀（本机验证：接受）。

### 批次七：Docker 体验深化（2026-11-20 复分析新增）

对照 v2（§2.1/§2.2）后仍欠 fnOS 的体验项，装进一个收尾批次：

1. **按容器实时监控**：容器行「监控」→ 容器监控窗（CPU/内存/网络三图，`container_stats` 按容器流 + DockerOverview 同款自绘 SVG 组件抽取共用；采样纪律同概览）。
2. **复制容器**：容器「更多」菜单「复制」→ 以 inspect 结果预填创建向导（名称自动 +copy 后缀、**默认不启动**——fnOS 语义），纯 UI 组合。
3. **容器详情增强**：DetailDrawer 对齐 inspect 全量（挂载/网络/环境变量/标签分区折叠展示 + 复制 JSON）。
4. **日志页形态**：错误日志分离（stderr 流拆分或关键字过滤，fnOS errLog 语义）+ 空态/获取中态接 WbEmpty。
5. **loading 态枚举补齐**：pulling/removing/restarting/creating/pruning… en+zh 成对，全部写操作挂对应文案。
6. **窄窗规范**：Docker 六页内容 `min-w-[850px]` + 横向滚动（fnOS §G9），窗口过窄不再挤压塌陷。

验收：真机逐项走查 + 每项 spec；页宽规范以 400px 窗宽截图佐证不塌。

### 批次六（收口）

（待回填。）
