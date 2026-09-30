# WorkBuddy：Skill 从目录发现到工具执行

假设你给一个项目写了 `expense-summary` Skill，规定费用先按类别汇总；安装包里恰好有同名 Skill，要求先按日期汇总。用户只说“汇总这三笔费用”，模型会收到哪一份说明？即使界面显示 Skill 已加载，为什么后续查询工具仍可能不可用？这两个问题分别发生在候选发现和动作执行阶段，把它们都叫“加载插件”，就很难定位错误。

这里的 Skill 是放在目录里的任务方法说明，通常以 `SKILL.md` 告诉 Agent 什么时候使用、按什么步骤做事。它不是模型权重，也不等于可执行工具；工具还要经过单独的发现与授权。本篇跟踪 WorkBuddy 如何把磁盘上的方法说明变成模型可用的上下文，再衔接真正的工具调用。先修是 [Function Calling](#/lesson/function-calling)：模型提出调用请求，宿主执行动作并返回结果。这里依据 2026-09-28 实际读取的 WorkBuddy 5.6.2 安装材料；代码说明可见分支，Skill 文档说明作者约定，例子全部是假设，未运行供应商代码。文中 [S09—S22 定位索引](https://jiuchenm.github.io/workbuddy-study/#S09) 指向本地安装文件的位置，并非公开源码链接；具体 entry、行号与 symbol 写在对应事实旁。

## 目录里的文件如何成为候选

Skill 通常由一个 `SKILL.md` 和可选资源组成。文件开头的 frontmatter，也就是以 `---` 分隔的元数据区，告诉宿主它叫什么、适用于什么任务；后面的正文说明操作方法。这个划分让候选列表可以先展示简短入口，选中后再给模型完整步骤。磁盘上有文件，只是发现流程的输入，尚不能证明它已进入当前会话。

在 `cli/dist/codebuddy-lite-wb.mjs` L852，`SkillProductProvider.loadSkills` 依次扫描 project、user、connector、`CODEBUDDY_SESSION_SKILL_DIRS` 中的目录，最后用 bundled Skill 补缺。这里的 project 是通过路径工具取得的项目目录；环境变量提供的 session 目录也被标记为 project 来源，但扫描位置更晚。因此，不能仅凭来源标签推断处理顺序。[目录 provider：S10](https://jiuchenm.github.io/workbuddy-study/#S10)

它维护了两类不同的去重状态：已经读取过的文件路径，以及较早一批候选已占用的名字。后一批中遇到同名条目就跳过，所以在这个 provider 内，项目的 `expense-summary` 可以遮蔽 bundled 的同名候选。这是候选集合的取舍，不会删除安装文件。另一个容易漏掉的细节是：每批内部还按 `id`，没有 `id` 时按 `name` 去重；一批处理完后才把名称加入跨批集合。因而不能把实现简化成“所有同名文件永远只保留第一个”。本例只放一个 project 条目和一个 bundled 条目，避开同一目录批次内的重名问题。

`scanSkillsDirectory` 递归寻找名称精确为 `SKILL.md` 的文件，根目录深度从零开始，超过 `MAX_SCAN_DEPTH = 5` 就返回；子目录使用受并发上限控制的遍历，扫描结束后按深度和路径排序。目录无法读取、文件解析失败等情况被记录并跳过。这个边界说明为什么“我把文件放进很深的目录”不能保证被发现。更重要的是，这套顺序只属于上述目录 provider；插件有另一个 loader，后面还有配置合并，不能把它提升成整个插件系统的统一优先级。[同一 entry L852，`scanSkillsDirectory`、`loadBundledSkills`：S10](https://jiuchenm.github.io/workbuddy-study/#S10)

## 元数据解析会改变实际身份

假设项目文件开头是下面的内容，正文再给出汇总和校验步骤：

```yaml
---
name: expense-summary
description: 按费用类别汇总用户提供的金额，并列出各类别小计与总额。
allowed-tools:
  - Read
  - Bash
---
```

这份元数据的 `name` 用来识别候选，`description` 帮助模型判断是否适用。`allowed-tools` 被解析为列表；它与普通自然语言“请读取文件”不同，是结构化字段，但这里只确认解析器保存了它，不能从字段存在直接推出后续所有权限规则。

provider 的 `parseSkillFile` 调用 `readFile` 读取整个文件，经 `extractFrontMatterWithContent` 分出元数据和正文。这个简化解析器逐行处理键值、布尔值、数字、列表和块文本；没有匹配到前置分隔区时，返回空元数据并保留原文。因此，不能因为格式看起来像 YAML，就默认所有 YAML 语法都得到相同支持。另一个插件 loader 的 `parseSkillFile` 使用 `extractFrontMatterFull`，交给 YAML parser 解析，并能报告 `parseError`；两条入口的解析能力不能混为一谈。位置分别是 `cli/dist/codebuddy-lite-wb.mjs` L852、L844 的 `parseSkillFile`，底层两个 frontmatter 方法在 L2643。[目录入口：S10](https://jiuchenm.github.io/workbuddy-study/#S10)、[插件入口：S54](https://jiuchenm.github.io/workbuddy-study/#S54)

例如 `name: 1024` 在简化解析中会变成数字，随后被字符串检查拒绝，名称退回由路径推导的结果；写成 `name: "1024"` 才保留字符串身份。路径推导还可能把嵌套目录组合成带冒号的名称。于是，重名覆盖比较的是解析后的 `name`，不是文件夹看起来叫什么。解析器同时保存 `location`、`baseDirectory`、`source` 和正文 `instructions`，资源相对路径才有可依赖的起点。排查错用方法时，应核对实际名称和来源，而非只看展示标题。

## 缓存结果与共享加载过程

发现候选要遍历目录并读取文件。如果几个组件同时需要 Skill 列表，只在读取结束后缓存结果仍会重复扫描：请求甲尚未完成，请求乙看到缓存为空，也开始扫描。L852 的 `loadSkillsCached` 因此同时保存结果 `skillsCache` 和进行中的 Promise `skillsLoading`。Promise 表示尚未完成的同一项异步工作；后来的调用等待它，不再启动另一份扫描。

首次调用没有结果也没有加载任务，便创建 `loadSkills()`；并发调用复用正在进行的 Promise；成功后保存结果，后续调用直接返回副本。`cloneSkills` 复制候选对象，并单独复制 `allowedTools` 数组，减少调用者改动这些返回值时污染缓存的机会。`finally` 清理进行中状态，因此这不是把一个 Promise 永久当作列表保存。[`cli/dist/codebuddy-lite-wb.mjs` L852，`loadSkillsCached`、`cloneSkills`：S10](https://jiuchenm.github.io/workbuddy-study/#S10)

结果缓存省下重复读取，也引入更新问题：磁盘改了，缓存不一定随之变化。可见的 `provide` 在收到 `force` 时调用 `clearCache`，清掉结果和加载状态；这证明存在强制重读入口，不证明每次编辑都立即触发它，更不等于已取消先前的磁盘任务。本篇没有检查全部刷新事件，也没有测量缓存速度。因此遇到旧正文，应该先区分文件未发现、候选被遮蔽、缓存未刷新和模型未选择，不能一律归咎于模型“不听话”。

## 渐进展开发生在模型上下文里

安装包内的 `resources/plugins/workbuddy-builtin/skills/skill-creator/SKILL.md` L81—89 把内容分为元数据、触发后的正文、按需使用的资源。这个约定的目标是少让无关说明占据模型上下文。它没有否定前面的 `readFile`：磁盘层完全可以先读完并缓存正文，模型层再决定何时看到正文。把“渐进展开”解释成“触发前连磁盘正文都不读取”，与本次查到的两个 loader 都不符。[作者约定：S09](https://jiuchenm.github.io/workbuddy-study/#S09)

实际模型入口也不是无限长的目录。`cli/dist/codebuddy-lite-wb.mjs` L1820 的 `renderToolDescriptionFromProduct` 会过滤模型不可见的候选；L1829 的 `truncateSkillsByCharBudget` 给描述设置预算，必要时缩短描述、只留名称，或者省略超出数量限制的用户 Skill。因此“元数据先进入上下文”是一种设计分层，不能解释为所有安装条目的完整描述始终可见。[Skill 描述装配与预算：S52](https://jiuchenm.github.io/workbuddy-study/#S52)

选择之后，L1981 的 `executeSkill` 查找候选并检查能否由模型调用。在普通上下文分支，它把已保存的 `instructions` 交给 renderer 处理，返回正文和 `baseDirectory`；另有 `context: fork` 分支，本篇不展开。这里显示“Skill loaded”，表示方法说明已经返回。它并没有替正文执行所有步骤，也没有证明最终业务完成。[同一 entry 的 `executeSkill`：S53](https://jiuchenm.github.io/workbuddy-study/#S53)

正文可以再指向 `references/` 中的详细规则、`scripts/` 中的可执行程序和 `assets/` 中的模板。这三类资源的用途不同：参考文档需要进入模型理解范围；脚本可以通过工具运行，不必先把每行代码放进上下文；模板文件可以成为产物基础。是否读取、执行或复制，仍需要后续动作。作者应把必要资源入口写清楚，否则“附件在目录里”并不会自动让模型知道什么时候使用它。[Skill Creator L50—89：S09](https://jiuchenm.github.io/workbuddy-study/#S09)

## Plugin 组织资源，工具策略决定可用动作

Plugin manifest 是描述插件组成的清单。实际的 `resources/plugins/workbuddy-builtin/builtin-plugins/sheetagent/.codebuddy-plugin/plugin.json` L16—32 同时声明 `commands`、`skills`、`hooks` 和 `mcpServers`。其中 MCP server 使用 `node` 启动插件相对路径下的程序，并带有 `defer_loading: true`。这说明一份插件可以把说明、命令入口、生命周期处理和动作接口一起分发；manifest 本身不等于 server 已启动、账号已认证或工具已调用。[SheetAgent 清单：S11](https://jiuchenm.github.io/workbuddy-study/#S11)

延迟加载的工具定义通过 ToolSearch 等机制按需发现，与 Skill 正文的渐进展开是不同层次。`main/server.js` L41075—41126 的 `resolveSessionBuiltinToolNames` 区分直接可用、deferred 和 explicit-only：在该 builtin 域内，ToolSearch 或显式 `Defer(...)` 可以使普通 deferred 工具进入允许集合；`workbuddy_request_mcp_connection` 属于 explicit-only，仅有 ToolSearch 不够，仍需显式配置。此规则不能直接套到独立的第三方 MCP server。[builtin 策略：S21](https://jiuchenm.github.io/workbuddy-study/#S21)

再下一层，L46039—46127 可见按 server 保存的禁用工具记录，以及 `enabled`、`trusted`、connector 会话集合和 browser 开关等条件。这里的 scope 指本会话获准看到哪些连接或工具；Skill 中的指令则说明应当怎样做。模型读到“调用某工具”，不会改变这些程序状态，也不能生成真实凭据。工具发现、路由和执行的完整过程见 [WorkBuddy 工具管理](#/lesson/workbuddy-tools)。[MCP 策略与上下文过滤：S22](https://jiuchenm.github.io/workbuddy-study/#S22)

## 把一次费用汇总走完

现在补齐开头的假设。project 和 bundled 各有一个解析后名为 `expense-summary` 的文件；没有其他同名条目，候选允许模型调用，也未被描述预算省略。用户提供交通费 120 元、交通费 80 元、餐费 50 元，要求“按项目约定汇总”。这些金额只用于手算。

首次发现时，provider 先扫描 project，保存按类别汇总的说明；扫描 bundled 时，发现名称已被前面来源占用，不再把按日期汇总的版本加入结果。这不是模型在两份正文里投票。此处的 bundled 特指该目录 provider 的 bundled 来源，不能换成任意插件再沿用结论。若同时有另一组件请求列表，它等待相同的加载 Promise；完成后取得候选副本。

模型看到名称和适用描述后，请求加载 `expense-summary`。普通 `executeSkill` 返回项目正文和它的资源基目录。假设正文要求读取 `references/categories.md` 以核对分类，再用随包脚本做求和，模型就需要分别请求可用的读取和执行工具。脚本名称、引用文件与执行结果在这里都是教学假设，不能当作 WorkBuddy 随包功能清单。

假设读取确认两笔交通费归为一类，工具执行成功并返回计算结果，才有依据报告交通费 200 元、餐费 50 元、总额 250 元。检查方法是把分组小计相加，确认与原始三笔金额相符。如果工具未启用，流程应停在缺少可执行能力这一层；若只成功加载正文，则最多说明“取得了方法”，不能报告“脚本已校验”。这条链上的候选身份、上下文内容和执行结果各有证据，任何一层成功都不能替代下一层。

<details>
<summary>面试怎么回答</summary>

**一分钟回答：** WorkBuddy 的 Skill 先经目录或插件 loader 变成带名称、描述、来源和正文的候选。一个可见目录 provider 按 project 到 bundled 的顺序处理，较早来源遮蔽较晚的同名候选，但不能推成全插件优先级。加载结果被缓存，并发请求共享正在加载的 Promise。loader 实际读取全文；渐进展开主要指模型先看入口、选中后取得正文，再按需使用资源。Plugin manifest 可以把 Skill 和 MCP 等组件组织在一起，但方法说明不会自动授予权限。真正动作仍经过会话工具策略、调用和结果回传。

**追问一：缓存了结果，为什么还缓存 Promise？** 结果只能在扫描结束后复用。缓存 Promise 可以让同时到达的请求等待同一次扫描，避免缓存尚空时各自重复启动工作。两者都还需要明确刷新边界，否则新文件或新正文可能没有进入返回结果。

**追问二：为什么 Skill loaded 不代表任务成功？** 普通 Skill 执行分支返回的是正文和资源基目录。正文里的读取、计算或查询还需要后续工具完成；只有实际结果才能支持对应业务结论。工具被会话策略排除时，正文也无法让它自动可用。

</details>

练习：项目与 bundled 各有一个名为 `expense-summary` 的候选。首次发现完成后，你把项目正文从“按类别”改成“按日期”，没有触发已知强制刷新入口。此时模型加载 Skill 后仍按类别处理。能否据此认定模型忽视了指令，或 bundled 覆盖了项目？需要补查哪几项证据？

<details>
<summary>练习参考思路</summary>

两种结论都过早。先核对解析后的名称、来源和 location，确认选中的确是项目候选；再检查这次返回的 instructions 是否仍来自旧缓存，以及是否发生了重读。磁盘文件已更新，不等于本次返回的正文已更新。只有确认新正文实际进入模型上下文后，才能继续判断后续行为是否偏离指令。在题设这一 provider 和两条候选范围内，bundled 负责补缺，不能用“安装包优先”解释现象。

</details>
