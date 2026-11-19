# Linux 桌面五期：Semi Design 视觉重构 + Docker 管理器对齐 the reference — 开发计划（立项）

> 2026-11-19 立项，基线 `desktop-iteration`（tip `1420da4`，含四期全部工作与远端批次七/八/九开篇）。
> 目标用户口径：**「引入 Semi Design 重构 Linux 桌面的 UI，重点丰富 Docker 管理器的功能，主要功能模块参考the reference product来设计」**。
> 输入材料：[the reference UI 精华拆解-调研报告](../调研报告/20261119-0302-reference-ui-research.md)（Semi 令牌实测值/桌面形态/Docker 深潜 §G）、[四期计划](20261119-0302-linux桌面四期the reference体验对标-开发计划.md)（既有裁定与双模式基础）。
> **与四期裁定的关系**：四期记录的「不引 Semi、不换品牌色」（四期计划 §一第 6 条、§二裁定表、§十一）经用户显式改向**部分作废**——本五期重新裁定并在四期计划顶部加指针；其余裁定（不做第二套组件运行时、影响面锁死、验收五件套）继续有效。

## 一、最高技术决策：Semi Design 只有 React 版（先读这里）

**事实（2026-11-19 核实）**：Semi Design（抖音 douyinfe/semi-ui）官方仅提供 **React** 实现；官方 Issue #56 明确 Vue 版优先级低、依赖社区移植，无官方 Vue 3 包。7shell 前端是 Vue 3 + Tailwind v4，全应用约 117 个 .vue。

| 路线 | 内容 | 判定 |
|---|---|---|
| **A：Semi 设计系统落地（推荐）** | 引入 **Semi 的令牌体系与视觉规范**（`--semi-*` CSS 变量层 + 组件视觉规格），把桌面域的自研组件（WbButton/WbTag/WbEmpty/对话框/菜单/表格/任务栏/启动器）按 Semi 视觉**重皮**；零新运行时依赖，Vue 栈不动 | **采用** |
| B：社区 Vue 移植 | semi-ui-vue 等非官方包：不成熟、停更风险、与 Tailwind v4 体系冲突、i18n/主题体系不合 | 否 |
| C：桌面域换 React | 推翻全应用架构（SPA 是 Vue），代价不可接受 | 否 |

**为什么 A 成立**：the reference 自己就是「React + Semi + Tailwind 混用」，其视觉来自 `--semi-color-*` 令牌层——而令牌层是纯 CSS 变量，与框架无关。我们在四期已把 the reference 的 Semi 令牌实测值全部提取（品牌蓝 `--semi-brand-5: 0,102,255`、语义三态浅底、时长 90ms/.12s/.18s、阴影三档），落地为 `--workbench-*`。五期要做的是**把令牌层升级为 Semi 命名法 + 按 Semi 规范重皮组件**，即「Semi 化的自研组件库」，而不是引 React 库。
**决策点 D1（已按推荐裁定）**：采用路线 A。若坚持「运行时真 Semi」，等价于路线 C 立项，需单独立项评审。

**决策点 D2（推荐，形态评审门确认）**：桌面域品牌色从 teal 切换为 **the reference/Semi 品牌蓝 `#0066FF`**（跟随"参考the reference product"的口径）；应用域（桌面之外的界面）保持现状不动。菜单/激活条/焦点环/选中态随之变蓝。
**决策点 D3（推荐，形态评审门确认）**：窗口内容面板改 Semi 面板视觉（实底 + `--semi-shadow-app` + 1px 描边）；桌面 chrome（任务栏/启动器/壁纸之上的玻璃）保留毛玻璃但色值全部走 Semi 令牌。

## 二、Docker 管理器对照（the reference 模块 → 7shell 现状 → 批次）

the reference Docker = 独立子应用，左导航六页签 + 服务设置；7shell 现状 = 桌面窗口内 `ContainerPane` 双模式（desktop：概览/容器/镜像三页签）。

| the reference 模块 | 7shell 现状 | 引擎能力 | 批次 |
|---|---|---|---|
| 概览（摘要+实时图+健康灯） | ✅ 已有（四期） | stats 已有 | 二（Semi 化） |
| 容器（9 态 tag/更多菜单/启停/删除确认） | ✅ 已有 | ✅ | 二（Semi 化） |
| **创建容器向导**（基本/高级分区卡：端口/存储/环境变量/网络/capabilities/命令/资源限制） | ❌（仅引擎 create 命令） | create 已有 | 二 |
| 容器终端（xterm+独立窗） | ✅（exec 已有） | ✅ | 二（Semi 化） |
| 容器日志（运行日志/错误分离） | ✅（流已有） | ✅ | 二 |
| 容器文件 | ✅ | ✅ | 二（Semi 化） |
| **Compose 项目**（列表/创建：yml 编辑+路径选择/启停/日志/删除） | ❌ | **需新增固定动词**（真机探明 Compose v5.7.1 插件在） | 四 |
| **本地镜像**（列表/更新流：5 步确认清单/防重复/「请先关闭容器」清单） | 部分（列表/拉取/删除） | pull/history 已有；比对逻辑前端 | 五 |
| **镜像仓库设置**（加速源拖拽排序 + 代理设置） | ❌ | **只读**：`docker info` 可见 mirrors；写=改 daemon.json+重启 docker（侵入红线，见 §七） | 五 |
| **网络**（列表/新增：子网 CIDR/网关/IPv6/驱动/删除护栏） | ❌ | **需新增固定动词**（真机探明 network 命令可用） | 三 |
| 服务设置（开关/存储迁移） | ❌ | systemd 已有通道 | 不做（见 §八） |
| 复制容器（默认不启动） | ❌ | inspect+create 组合 | 五（可选） |

## 三、视觉重构范围（Semi 化清单）

1. **令牌层**：`globals.css` 新增 `--semi-*` 桥接层（品牌蓝 0-9 阶、语义色三态浅底、灰阶 0-9 明暗反转、圆角 6px 控件、阴影三档、时长三档）——`--workbench-*` 从 `--semi-*` 派生，**一套事实源、两层命名**，避免双体系漂移；亮暗用现有 `.dark`/`:root` 翻转（the reference 的 `theme-mode` 同构）。
2. **组件重皮**：WbButton（primary=品牌蓝/secondary 白底描边/tertiary/warn + sm/md/lg + loading 态）、WbTag（浅底深字三态）、WbEmpty（Semi 插画风格重绘或保留现五场景）、`ConfirmDialog`/`DialogRoot` 组合、`ContextMenu`（teal→Semi dropdown 视觉）、`lib/table.ts` 表格（hover/选中/斑马纹/列分隔线，对齐 the reference trim-ui 表格）。
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
- 验收：真机建测试项目（nginx 单服务）→ 启动→日志→停止→删除，全链路；无 compose 插件的宿主只露概览（the reference 语义）。

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

- 路线 B（社区 Vue 移植）/路线 C（桌面域 React 化）；Semi 运行时库引入；写 daemon.json/重启 docker 自动化（只读+建议）；Docker 卷管理页（the reference 六页签无卷，对齐）；服务开关/存储迁移（侵入）；40px 超圆弹窗；全局禁用右键；应用级界面 Semi 化。

## 九、与既有文档的冲突处理（同批更新）

- 四期计划 §一第 6 条/§二/§十一的「不引 Semi/不换品牌色」→ 顶部加「五期改向指针」，原文保留不删（历史账）。
- `docs/ui-conventions.md`：若 Semi 字号/交互规格与「四档字号」宪法冲突，批次一先修订契约再落码（宪法修订不是违反）。
- `docs/architecture.md`：桌面域不变量不受影响（令牌层是前端事）；如 lane 变更触及再补。

## 十、批次实施记录（实施后逐批回填）

### 批次一（Semi 令牌层 + chrome 重构）

（待回填：读数、提交哈希、形态评审结论、安装包哈希。）

### 批次二（Docker 页 Semi 化 + 创建向导）

（待回填。）

### 批次三（网络管理）

（待回填。）

### 批次四（Compose 项目）

（待回填。）

### 批次五（镜像更新流 + 仓库设置）

（待回填。）

### 批次六（收口）

（待回填。）
