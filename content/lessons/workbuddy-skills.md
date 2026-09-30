# WorkBuddy：Skill 从目录发现到工具执行

**Skill 是任务方法说明**：通常以 `SKILL.md` 告诉 Agent 什么时候使用、按什么步骤做事，还可以附带参考文档、脚本和模板。工具则提供实际动作，例如读取文件或运行脚本。Skill 可以要求 Agent 使用某个工具，但这份文字本身不会执行动作，也不会自动授予工具权限；它与模型权重也没有同一含义。

假设项目里有一个 `expense-summary` Skill，规定按费用类别汇总；安装包里恰好有同名 Skill，规定按日期汇总。用户给出交通费 120 元、交通费 80 元、餐费 50 元，要求“按项目约定汇总”。宿主要先决定保留哪一份候选，再让模型取得方法，最后才轮到工具执行。即使界面显示 Skill 已加载，也仍可能停在工具不可用的位置。本篇沿这一个教学假设走完输入、选择、执行和输出，金额只用于手算，例子未实际运行。

先修是 [WorkBuddy 上下文](#/lesson/workbuddy-context) 和 [Function Calling](#/lesson/function-calling)：前者解释会话输入的装配，后者解释模型提出调用请求、宿主执行并回传结果。实现依据是 2026-09-28 固定的 WorkBuddy 5.6.2 安装材料，2026-10-01 重读关键片段并核对文件 SHA-256 一致。本文只解释可见代码分支；随包 Skill 文档表达作者约定，不代表运行保证。[S09—S22 定位索引](https://jiuchenm.github.io/workbuddy-study/#S09) 指向本地安装 entry，不是公开源码，具体路径、行号和 symbol 标在对应事实旁。本次未执行供应商代码或读取用户配置。

## 目录里的文件如何成为候选

宿主首先需要一份可选择的 Skill 列表。`SKILL.md` 开头的 frontmatter，即以 `---` 分隔的元数据区，提供名称和适用描述；后面的正文提供方法。宿主可以把两部分分别用于候选入口和选中后的说明。对本例来说，磁盘上有两份文件只是起点，还要经过扫描、解析和去重，才能知道列表里留下谁。

在 `cli/dist/codebuddy-lite-wb.mjs` L852，`SkillProductProvider.loadSkills` 依次扫描 project、user、connector、`CODEBUDDY_SESSION_SKILL_DIRS` 中的目录，最后用 bundled Skill 补缺。这里的 project 是通过路径工具取得的项目目录；环境变量提供的 session 目录也被标记为 project 来源，但扫描位置更晚。因此，不能仅凭来源标签推断处理顺序。[目录 provider：S10](https://jiuchenm.github.io/workbuddy-study/#S10)

这里的 provider 是提供候选列表的组件。它分别记住已读文件路径、较早批次占用的名称；后一批遇到同名候选就跳过。因此在本例中，project 的 `expense-summary` 先占用名称，bundled 的同名候选不能再进入这个 provider 的结果。**同名取舍由宿主代码完成**，模型不用在两份正文之间投票；安装文件本身仍然存在。

这条规则有明确范围。每批内部还按 `id` 去重，没有 `id` 才按 `name`；处理完一批后，才把名称加入跨批集合。因此不能简化成“整个系统的所有同名文件永远只保留第一个”。本例只放一个 project 条目和一个 bundled 条目，没有其他同名候选，避开同一批次内的重名情况。

`scanSkillsDirectory` 递归寻找名称精确为 `SKILL.md` 的文件，根目录深度从零开始，超过 `MAX_SCAN_DEPTH = 5` 就返回；子目录使用受并发上限控制的遍历，扫描结束后按深度和路径排序。目录无法读取、文件解析失败等情况被记录并跳过。这个边界说明为什么“我把文件放进很深的目录”不能保证被发现。更重要的是，这套顺序只属于上述目录 provider；插件有另一个 loader，后面还有配置合并，不能把它提升成整个插件系统的统一优先级。[同一 entry L852，`scanSkillsDirectory`、`loadBundledSkills`：S10](https://jiuchenm.github.io/workbuddy-study/#S10)

## 元数据解析会改变实际身份

发现文件后还要解析身份，否则无法可靠比较“同名”。本例项目文件的开头如下，属于教学示例，正文再写分类、求和与校验步骤：

```yaml
---
name: expense-summary
description: 按费用类别汇总用户提供的金额，并列出各类别小计与总额。
allowed-tools:
  - Read
  - Bash
---
```

解析后的 `name` 用来识别候选，`description` 帮助模型判断是否适合费用汇总。`allowed-tools` 会被保存为列表，属于结构化字段；本次只核对了字段解析，未审计它参与的全部权限规则。即使列表写着 `Read`、`Bash`，也不能据此认定这次会话已经具备读取或执行能力。

provider 的 `parseSkillFile` 调用 `readFile` 读取整个文件，经 `extractFrontMatterWithContent` 分出元数据和正文。这个简化解析器逐行处理键值、布尔值、数字、列表和块文本；没有匹配到前置分隔区时，返回空元数据并保留原文。因此，不能因为格式看起来像 YAML，就默认所有 YAML 语法都得到相同支持。另一个插件 loader 的 `parseSkillFile` 使用 `extractFrontMatterFull`，交给 YAML parser 解析，并能报告 `parseError`；两条入口的解析能力不能混为一谈。位置分别是 `cli/dist/codebuddy-lite-wb.mjs` L852、L844 的 `parseSkillFile`，底层两个 frontmatter 方法在 L2643。[目录入口：S10](https://jiuchenm.github.io/workbuddy-study/#S10)、[插件入口：S54](https://jiuchenm.github.io/workbuddy-study/#S54)

例如 `name: 1024` 在简化解析中会变成数字，随后被字符串检查拒绝，名称退回由路径推导的结果；写成 `name: "1024"` 才保留字符串身份。路径推导还可能把嵌套目录组合成带冒号的名称。这说明重名比较使用**解析后的名称**，文件夹同名不足以证明候选同名。本例需要确认两条候选确实都解析为 `expense-summary`。

解析器还保存 `location`（文件位置）、`baseDirectory`（资源基目录）、`source`（来源）和 `instructions`（正文）。这几个字段分别回答“是哪份文件、附件相对哪里找、来自哪个来源、实际方法是什么”。后续如果费用被错误地按日期汇总，就可以逐项检查身份和内容，而不只看界面标题。

## 缓存结果与共享加载过程

假设两个组件几乎同时请求本例的 Skill 列表。第一个还在扫描时，第二个看不到完成结果；若只缓存结果，它也会启动扫描。L852 的 `loadSkillsCached` 因此同时保存结果 `skillsCache` 和进行中的 Promise `skillsLoading`。Promise 表示尚未完成的异步工作，后来的调用可以等待同一次加载。

首次调用没有结果也没有加载任务，便创建 `loadSkills()`；并发调用复用正在进行的 Promise；成功后保存结果，后续调用直接返回副本。`cloneSkills` 复制候选对象，并单独复制 `allowedTools` 数组，减少调用者改动这些返回值时污染缓存的机会。`finally` 清理进行中状态，因此这不是把一个 Promise 永久当作列表保存。[`cli/dist/codebuddy-lite-wb.mjs` L852，`loadSkillsCached`、`cloneSkills`：S10](https://jiuchenm.github.io/workbuddy-study/#S10)

结果缓存省下重复读取，也让“修改文件”和“本次取得新内容”之间多了一步。若首次扫描已经缓存按类别汇总的正文，此后修改项目文件，不一定立即改变返回结果。可见的 `provide` 在收到 `force` 时调用 `clearCache`，清掉结果和加载状态；这证明存在强制重读入口，不证明每次编辑都会触发它，也不证明先前的磁盘任务已取消。本篇未检查全部刷新事件、并发失效竞态或缓存性能。排查旧方法时，要先区分文件未发现、候选被遮蔽、缓存未刷新和模型未选择。

## 渐进展开发生在模型上下文里

本例的候选列表已经准备好，但模型不必立即收到每个 Skill 的完整方法。安装包内的 `resources/plugins/workbuddy-builtin/skills/skill-creator/SKILL.md` L81—89 把内容分为元数据、触发后的正文、按需使用的资源。这是 Progressive Disclosure（渐进展开）：先给选择所需的入口，再给选中方法的正文与附件，用来减少无关内容占据上下文。[作者约定：S09](https://jiuchenm.github.io/workbuddy-study/#S09)

要区分**磁盘读取与模型可见**两个时间点。前面两个 loader 都会读取全文并保存正文，所以宿主可以已经缓存按类别汇总的步骤，而模型此时只看见名称与描述。渐进展开发生在提供给模型的上下文里，不能解释成“触发前连磁盘正文都不读取”。

实际模型入口也不是无限长的目录。`cli/dist/codebuddy-lite-wb.mjs` L1820 的 `renderToolDescriptionFromProduct` 会过滤模型不可见的候选；L1829 的 `truncateSkillsByCharBudget` 给描述设置预算，必要时缩短描述、只留名称，或者省略超出数量限制的用户 Skill。因此“元数据先进入上下文”是一种设计分层，不能解释为所有安装条目的完整描述始终可见。[Skill 描述装配与预算：S52](https://jiuchenm.github.io/workbuddy-study/#S52)

继续本例，假设候选可由模型调用，描述也未被预算省略。模型根据名称与描述选择 `expense-summary`，请求加载它。L1981 的 `executeSkill` 查找候选并检查能否由模型调用；普通上下文分支把已保存的 `instructions` 交给 renderer（内容处理组件），返回正文和 `baseDirectory`。另有 `context: fork` 分支，本篇不展开。此时模型才取得按类别汇总的方法。**Skill loaded 表示方法已返回**，后面的读取和计算仍待完成。[同一 entry 的 `executeSkill`：S53](https://jiuchenm.github.io/workbuddy-study/#S53)

假设正文要求先读 `references/categories.md` 核对分类，再用随包脚本求和。这两个资源及其使用方法都是教学假设，不是 WorkBuddy 内置功能清单。模型需要根据返回的 `baseDirectory` 找到相对路径，并请求读取或执行工具；资源文件不会仅因位于同一目录就自动完成任务。

随包指南区分了 `references/` 的详细规则、`scripts/` 的可执行程序和 `assets/` 的输出模板。参考文档提供理解所需的内容；脚本可以通过工具运行，不必先把每行代码放进上下文；模板可以成为产物基础。是否读取、执行或复制，仍由后续动作落实，作者需要写清必要资源入口。[Skill Creator L50—89：S09](https://jiuchenm.github.io/workbuddy-study/#S09)

## Plugin 组织资源，工具策略决定可用动作

模型取得费用汇总方法后，还要确认本次会话有可用工具。Skill 有时与工具放在同一个 Plugin（插件包）里分发，但两者在包里相邻，不代表加载方法就会完成连接。

Plugin manifest 是描述插件组成的清单。实际的 `resources/plugins/workbuddy-builtin/builtin-plugins/sheetagent/.codebuddy-plugin/plugin.json` L16—32 同时声明 `commands`、`skills`、`hooks` 和 `mcpServers`，分别组织命令入口、方法说明、生命周期处理和 MCP 动作接口。清单声明用 `node` 启动插件相对路径下的 MCP server 程序，并带有 `defer_loading: true`。这是“同包分发”的实物证据，不代表本例使用 SheetAgent，也不证明 server 已启动、账号已认证或工具已调用。[SheetAgent 清单：S11](https://jiuchenm.github.io/workbuddy-study/#S11)

延迟加载的工具定义通过 ToolSearch 等机制按需发现，与 Skill 正文的渐进展开是不同层次。`main/server.js` L41075—41126 的 `resolveSessionBuiltinToolNames` 区分直接可用、deferred 和 explicit-only：在该 builtin 域内，ToolSearch 或显式 `Defer(...)` 可以使普通 deferred 工具进入允许集合；`workbuddy_request_mcp_connection` 属于 explicit-only，仅有 ToolSearch 不够，仍需显式配置。此规则不能直接套到独立的第三方 MCP server。[builtin 策略：S21](https://jiuchenm.github.io/workbuddy-study/#S21)

再下一层，L46039—46127 可见按 server 保存的禁用工具记录，以及 `enabled`、`trusted`、connector 会话集合和 browser 开关等条件。这里的 scope 是本会话获准看到的连接或工具范围，Skill 指令描述的是做事方法。加载“读取分类表”这句话不会改变上述程序状态，也不能生成真实凭据。本次只读取处理这些条件的代码，没有读取其用户配置。工具发现、路由和执行的完整过程见 [WorkBuddy 工具管理](#/lesson/workbuddy-tools)。[MCP 策略与上下文过滤：S22](https://jiuchenm.github.io/workbuddy-study/#S22)

## 把一次费用汇总走完

假设本例的读取与执行工具均可用。模型先请求读取分类规则，工具返回两笔交通费属于一类；随后模型请求运行求和脚本，宿主执行并把结果返回。模型现在才有依据按这条执行链报告结果。下面是手算得到的假设输出，未实际运行脚本：

| 类别 | 输入金额 | 小计 |
| --- | --- | --- |
| 交通费 | 120 元、80 元 | 200 元 |
| 餐费 | 50 元 | 50 元 |
| 总额 | 三笔费用 | 250 元 |

校验是把分组小计相加：200 + 50 = 250，与原始三笔的 120 + 80 + 50 一致。若工具未启用，流程停在缺少执行能力的位置；若只成功加载正文，就只能说明取得了方法，不能声称脚本已校验。

回看整条链，可以分别追问：候选来自哪个文件，本次返回哪份正文，工具实际做了什么。project 遮蔽 bundled 只回答第一个问题；正文加载回答第二个；工具结果才回答第三个。固定快照的归档 SHA-256 为 `c4304eec1f8849ea16b9492f02dcc5d1e93be4a7aed184b7effaabd2f06c9d22`，本次核对相同；这固定了本文的代码材料，仍不证明当前进程正在使用该 bundle、某个真实会话选择了这些分支，或费用任务已成功。

<details>
<summary>面试怎么回答</summary>

**一分钟回答：** WorkBuddy 的 Skill 先经目录或插件 loader 变成带名称、描述、来源和正文的候选。一个可见目录 provider 按 project 到 bundled 的顺序处理，较早来源遮蔽较晚的同名候选，但不能推成全插件优先级。加载结果被缓存，并发请求共享正在加载的 Promise。loader 实际读取全文；渐进展开主要指模型先看入口、选中后取得正文，再按需使用资源。Plugin manifest 可以把 Skill 和 MCP 等组件组织在一起，但方法说明不会自动授予权限。真正动作仍经过会话工具策略、调用和结果回传。

**追问一：缓存了结果，为什么还缓存 Promise？** 结果只能在扫描结束后复用。缓存 Promise 可以让同时到达的请求等待同一次扫描，避免缓存尚空时各自重复启动工作。两者都还需要明确刷新边界，否则新文件或新正文可能没有进入返回结果。

**追问二：为什么 Skill loaded 不代表任务成功？** 普通 Skill 执行分支返回的是正文和资源基目录。正文里的读取、计算或查询还需要后续工具完成；只有实际结果才能支持对应业务结论。工具被会话策略排除时，正文也无法让它自动可用。

**追问三：渐进展开为什么还能提前读全文？** 宿主读取磁盘文件和把内容交给模型是两个动作。loader 可以先读全文并缓存，模型先看名称与描述，选中后再取得正文，之后按需使用资源。描述还有可见性和预算限制，所以连入口也不能理解为所有安装条目都完整可见。

</details>

练习：项目与 bundled 各有一个名为 `expense-summary` 的候选。首次发现完成后，你把项目正文从“按类别”改成“按日期”，没有触发已知强制刷新入口。此时模型加载 Skill 后仍按类别处理。能否据此认定模型忽视了指令，或 bundled 覆盖了项目？需要补查哪几项证据？

<details>
<summary>练习参考思路</summary>

两种结论都过早。先核对解析后的名称、来源和 location，确认选中的确是项目候选；再检查这次返回的 instructions 是否仍来自旧缓存，以及是否发生了重读。磁盘文件已更新，不等于本次返回的正文已更新。只有确认新正文实际进入模型上下文后，才能继续判断后续行为是否偏离指令。在题设这一 provider 和两条候选范围内，bundled 负责补缺，不能用“安装包优先”解释现象。

</details>
