# 代码编辑规范：grep 优先读取

> **用途**：修改大文件（>300 行）时，用 grep 定位行号 + 精确 Read，替代全文读取。机制导入自 mybatis-plus-sql-visualizer 仓同名规范。
> **触发条件**：修改涉及 >300 行的文件时。

---

## 核心原则

> **先 grep 定位行号，再 Read 精确范围，最后 Edit 修改。绝不 Read 整个大文件。**

## 分级操作

### Level 1：简单修改（改文案 / 改条件 / 改一行）

```bash
rg -n "目标内容" crates/sevenshell-core/src/lib.rs   # 定位行号
Read 行号-5 ~ 行号+5                                  # 只看上下文
```

token 消耗：<100。不需要看全文。

### Level 2：修改方法逻辑（改参数 / 加返回值 / 改条件分支）

```bash
rg -n "fn connect" crates/sevenshell-ssh/src/session.rs   # 找函数体范围
Read 函数体                                                # 读完整函数
rg -n "涉及的字段名/结构体名" crates/                        # 找依赖的字段和类型
Read 字段声明区域                                           # 确认类型
```

token 消耗：~400。两轮 grep + 两轮小范围 Read。

### Level 3：重构 / 拆分（大改）

```bash
rg -n "^(pub )?(async )?fn |^pub struct |^pub enum |^impl " 文件.rs  # 列出所有声明
Read 关键区间（字段区 + 要改的函数 + 相关函数）
```

TS 侧同理：`rg -n "export (function|const|class|interface)" apps/desktop/src --type ts`。

token 消耗：~2K。先看清结构，再定向读取。

## 什么时候必须读全文

只有一种情况：**你不知道这个文件里有什么，也不知道要改哪里**。这时候需要探索。但探索完之后，后续修改都应该用 grep 定位。

## 会遗漏的场景（必须注意）

修改函数时，grep 只看到函数体，可能**遗漏依赖**：

- **字段声明**：函数里用的字段，声明可能在文件顶部或 `struct` 定义里（类型、可空性）
- **use / import**：函数里用的类型，导入在文件头
- **相关函数**：改 `connect()` 可能需要理解 `reconnect()` 的逻辑
- **trait / 接口契约**：改实现前先看 trait 定义；改 Rust 时注意 `impl` 块可能分散在多处

**应对**：每次修改前，用 grep 先确认涉及的字段和依赖，再定向 Read。不要跳过「找依赖」这一步。

## token 对比

| 场景 | 全文 Read | grep + 精确 Read | 节省 |
|------|-----------|-------------------|------|
| 改一行文案 | ~6,000 | <100 | 98% |
| 改函数逻辑 | ~6,000 | ~400 | 93% |
| 重构拆分 | ~6,000 | ~2,000 | 68% |

## 注意事项

- grep/rg/find 命令跑在 shell 里，不消耗 token（是工具调用，不是 LLM 读取）
- 只有 Read 的内容才计入 token
- grep 输出的行号是 1-based
- Edit 的 old_string 必须与文件内容**逐字符匹配**，grep 定位后用 Read 确认精确内容再 Edit
