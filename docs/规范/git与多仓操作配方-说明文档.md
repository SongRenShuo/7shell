# Git 与多仓操作配方

> 从 mybatis-plus-sql-visualizer 仓多会话并行开发实战沉淀的 git 配方，按 7shell 场景整理。教训的一句话版本见 [`LESSONS.md`](../LESSONS.md)（I32/I34/I44 等）；本文件写具体操作步骤。

## 一、暂存与提交

### `git add` 对被忽略目录静默无效的绕过（LESSONS I32）

```bash
# add -f 无效时（exit 0 但暂存区空）
hash=$(git hash-object -w <file>)
git update-index --add --cacheinfo 100644,$hash,<path>
# 提交后必回读确认
git ls-files | grep <file>
```

### 提交纪律

- 消息写 UTF-8 文件后 `git commit -F`；中文跨调用一律写文件传递（Bash 直传乱码）。
- 消息里禁反引号（Git Bash 命令替换：报错但提交仍成功、信息静默缺段）。
- 提交后 `git show --stat HEAD` 必须只列自己的文件——多车道/并行会话时 `git add` 只点明确路径，**禁 `-A`**（会卷走别的会话在途文件）。
- 提交身份先核：仓内写死 `user.email`（贡献归属按邮箱映射），错了用 `--reset-author` 修（LESSONS I44）。

### 编辑工具的锚点陷阱（LESSONS I34）

超长单行（表格行、状态行、锁文件）不能用行首前缀当 `old_string`——原行残余会粘到新行尾，且 `git diff --stat` 对单行文件恒显示 1 insertion 掩盖破坏。改完整行回读校验。

## 二、工作树与分支

### 清理作业口径

删工作树/分支前逐个核：`git worktree remove --force`（build 产物会挡）；分支删除前必验 tip 可达性——`git merge-base --is-ancestor <tip> master`（或 `git tag --contains`），否则唯一提交全库孤立。注意 cherry-pick 过的分支 `--contains` 失灵，判据改用 tree 哈希 + diff 空。

- 远端真值看 `git ls-remote`（本地 remote-tracking 会过期）。
- 删远端分支须用户点头。
- Windows 长路径删不掉：`\\?\` 前缀 + `rd /s /q` 写成 `.ps1` 执行。

### 共享工作树的三条禁令

1. 别家在途文档别用 `git stash push` 挪开（LESSONS I23——pop 冲突窗口里对方会把冲突标记提交进主干）。
2. 合并冲突逐 hunk 裁决；**文档类禁整侧 `--ours/--theirs`**（会静默丢掉另一侧新增行）。裁决前 `git show :2:<path>` / `:3:<path>` 各自落盘 diff，按行取并集再回填。
3. 长命令后台跑 + 全量落盘（LESSONS I27/I43 相关）。

## 三、多仓推送

- **仓名写死**：不读凭据文件里的 `repo` 字段拼 URL（常是从别的仓拷来的旧值，会把 A 仓提交推给 B 仓）。推送前回显目标 URL（token 打码）。
- **推送走令牌**：读 `.local/github-token.json`（或对应凭据文件），命令行 `-c credential.helper=` 置空凭据助手、`GIT_TERMINAL_PROMPT=0`——裸推会走 GUI 凭据管理器弹窗抢焦点（AGENTS.md 第 8 条）。
- **强推用显式 lease**：URL 直推不更新 remote-tracking，裸 `--force-with-lease` 会误报 stale；写全 `--force-with-lease=master:<旧 sha>`，动手前先 `ls-remote` 对齐双远端。
- **推送脚本纯 ASCII**：PowerShell 5.1 对无 BOM 的 `.ps1` 按 ANSI 解码，中文注释会吃掉下一行变量赋值（URL 变成 `…/owner/.git` 报 403，报错完全不指向「变量为空」）。

### Gitee 建仓三怪癖

1. 建 repo 的 `private:false` 会被忽略（201 仍私有）。
2. **空仓不能转公开（422）→ 先推内容再 PATCH `private=false`**，判据=匿名 raw 返回 200。
3. PATCH `/repos` 必须带 `name` 字段。

## 四、本机 Git Bash 工具链坑（速查）

| 坑 | 处置 |
|---|---|
| `grep` 是 ugrep 包装，`-c` 与管道静默返空 | 0 命中先怀疑工具；换 `rg` 或原生 grep |
| `unzip … \| grep -q` 假阴性 | 管道末命令退出码≠工具退出码；分步跑 |
| `comm` 对含中文/CRLF 清单恒「零交集」 | 集合运算改 `grep -F` |
| python 不认 `/f/` 风格路径 | 用 Windows 路径或 `cygpath -w` 单路径转换 |
| `sed -i` 会改行尾 | 改行尾敏感文件前先备份比对 |
| cygpath 转分号分隔清单整串当一个路径 | 清单原文直接用，不整体 cygpath |
| Git Bash 直调 `powershell -File` 吞退出码 | `-Command "& '...ps1' ...; exit $LASTEXITCODE"` |
| 含中文的 `.ps1` 无 BOM 被 PS 5.1 按 ANSI 炸 | 用 pwsh 7，或脚本纯 ASCII |
| MSYS 把 `/X` 参数转成路径 | 带 `/X` 参数的 Windows 工具一律写 `.ps1` 执行 |
