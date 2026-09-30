# WorkBuddy：文档与表格任务怎样交接和验收

假设用户给出一份销售工作簿，说“在这份文件里按地区汇总”。助手算出的地区销售和总额都对，却另存了一份新表，原工作簿没有变化。再假设助手用这些数字写了 DOCX：内容稿已经修改，转换步骤却读了旧 HTML，最终文件仍是旧版。两个任务都做出过正确内容，交到用户手里的对象却不符合要求。

**产物（artifact）是任务实际交付的文件。** 文档与表格任务需要把交付对象、内容版本和完成证据一起传到最后一步，因为写作、排版、转换、重算和保存可能由不同角色或工具完成。WorkBuddy 是桌面 Agent 应用；这里用它的安装实现说明，路由 Skill 怎样选择处理路线，领域角色怎样接收文件，脚本怎样检查结果，保存 Hook 怎样在指定事件发生后补做保存。Skill 是供 Agent 遵循的任务说明；脚本则有可检查的返回分支，两类材料能证明的事情不同。先修可见[工具层的身份与执行](#/lesson/workbuddy-tools)，Skill 的加载另见 [Skill 从发现到执行](#/lesson/workbuddy-skills)。

本文限定于 WorkBuddy **5.6.2 的固定安装包静态材料**：原阅读日期为 2026-09-28，2026-10-01 重读关键片段并核对 hash。整包 SHA256 为 `c4304eec1f8849ea16b9492f02dcc5d1e93be4a7aed184b7effaabd2f06c9d22`；各 entry 的 hash 保留在阅读记录中。这些证据解释随包流程约定与代码分支，不能证明真实任务每次遵循流程。以下销售数字、文件路径、评分和失败现场均为教学假设，未打开业务文件或运行供应商程序。来源链接是[安装材料定位索引](https://jiuchenm.github.io/workbuddy-study/#S12)，未公开对应源码全文；下文 entry 省略共同前缀 `resources/plugins/workbuddy-builtin/`。

## 先决定交付哪一个文件

路由是选择由哪条流程处理请求。“汇总成一张新表”首先有对象歧义：新工作簿是磁盘上的另一个 `.xlsx`；新工作表（sheet）则可能仍在原工作簿里。`skills/tencent-docs-routing/SKILL.md` L45—68 用交付物身份区分它们。生成独立工作簿要同时满足新文件意图、源材料只读、目标路径不同于源路径，才进入 `tencent-docs-sheet-generation`；在原文件添加汇总 sheet 属于原位修改。[Office 路由：S12](https://jiuchenm.github.io/workbuddy-study/#S12)

沿开头的例子，假设 `C:/Demo/sales.xlsx` 有三笔销售：华东 120、华东 80、华南 50。两种请求都要手算得到华东 `120 + 80 = 200`、华南 50、合计 `200 + 50 = 250`，但输入与输出契约不同：

| 用户请求 | 源文件的用途 | 最终应验收的对象 |
| --- | --- | --- |
| “另做 C:/Demo/summary.xlsx” | 只读参考 | 独立的 summary.xlsx，原文件未因汇总而修改 |
| “在 sales.xlsx 增加地区汇总 sheet” | 原位修改 | sales.xlsx 内新增的汇总 sheet |

因此，确认路线时需要看用户要改哪个对象。看到 `.xlsx` 附件只能确定文件类别，不能确定写入目标；算出 250 也不能弥补改错文件。

对于原工作簿，路由还区分确定性小修改和依赖数据理解的任务。把指定单元格改成给定值，可以从请求确定动作；按地区汇总则需要发现表头、识别记录、决定范围，进入 sheet-agent 路线。L116—118 要求原子委派（atomic delegation）：主层先解析文件身份，再把完整任务一次交出去，数据发现由领域 Agent 负责。主层如果先读写一部分再转交，子层收到的就可能是已变化的输入。这里的“原子”描述任务责任没有被拆散，没有承诺数据库事务或失败回滚。

这份 router 明确限定本地 Office/WPS 文件。安装包另有 `builtin-plugins/tencent-docs-plugin/skills/tencent-docs/SKILL.md` 面向 `docs.qq.com` 云文档，`tencent-saas-docs/SKILL.md` 面向 `saas.docs.qq.com` 企业文档；两者的说明列出创建、读取、编辑和文件管理等能力，并把通用管理与 doc、sheet、slide 精细编辑分到不同 MCP endpoint。它们要求先查工具参数定义，鉴权依赖宿主注入票据。这些是云端路线的随包说明，本例的本地路径和编辑器 ID 不能直接作为云文档调用参数。本次只读了能力与调用约定，没有查询云端工具清单、票据或权限，也未验证云端操作成功；腾讯文档名称相近，不足以把本地保存与云端写入当成同一动作。

## 路径和编辑器身份必须一同交清

选择原位汇总之后，还需要把 sales.xlsx 交给真正操作它的工具。路径定位磁盘文件；`file_id` 在路由约定中标识已打开的本地编辑器实例；`sheet_id` 标识实例中的工作表。窗口当前显示的对象、工具接收的身份与最终保存路径需要对应。即使某一实现暂时用绝对路径作 ID，也应使用工具返回的值，不能让模型从文件名拼出一个身份。[同一 router L140—146：S12](https://jiuchenm.github.io/workbuddy-study/#S12)

这一段安装材料留下了可检查的交接分歧。上层 router 要求主层先取得 live `file_id`，把 ID、绝对路径和用户原始请求传下去，并禁止子 Agent 自行解析；中间的 `builtin-plugins/sheetagent/skills/excel-handler/SKILL.md` L18—29 却只列路径、原始需求、当前时间、期望返回四项；下层 `agents/sheet-agent.md` L43—79 又允许缺少 ID 时调用 `resolve_local_excel` 解析路径或默认实例。[中间交接：S13](https://jiuchenm.github.io/workbuddy-study/#S13)、[下层解析：S14](https://jiuchenm.github.io/workbuddy-study/#S14)

这些材料暴露了一个交接检查点：上层生成的 ID 是否真的被中间层传下去。它们没有证明真实任务已经因此失败。对原位汇总例子，工程上的检查办法是追踪工具返回的 ID、`C:/Demo/sales.xlsx`、目标 sheet 和原始请求，看下层是否操作同一对象、保存是否仍指向该对象。这是据静态分歧提出的验收要求。缺字段时要修复传递契约；下层解析报错时应保留错误并停止，不能靠猜 ID 宣称恢复。

## DOCX 用产物类型连接阶段

假设用户另起一轮，直接给出华东 200、华南 50、合计 250，要求从零写一份约 1500 字的经营说明并交付 DOCX，没有附已有文档。此时任务从汇总表换成文档创作，交接还要回答：上一步产出哪种内容，下一步从哪里读取它？

`builtin-plugins/tencent-docx/skills/tdoc-orchestrator/SKILL.md` L32—65 定义了三阶段：S1 的 `doc-writer` 从意图生成 Markdown；S2 的 `doc-formatter` 把内容稿排成 HTML；S3 的 `doc-converter` 把 HTML 转成 DOCX 并打开预览。编排层（orchestrator）负责组织顺序和传递参数。类型化交接（typed handoff）在这里指明确规定产物格式和字段，不能直接等同于编译器已经实施了类型检查。[DOCX 编排：S16](https://jiuchenm.github.io/workbuddy-study/#S16)

销售数字从用户输入进入 S1 的内容稿；S2 接收稿件的 `final_draft_path`；S2 返回的 `formatted_output_path` 必须指向 HTML，编排层把它映射到 S3 的 `html_output_path`。目标 DOCX 的绝对路径在 Stage 0 写入 `pipeline-state.yaml`，converter 启动时读取。下面只示意字段如何对应，省略业务正文和部分可选字段，不是实际执行输出或可直接调用的 API 请求：

```yaml
stage1_result:
  final_draft_path: stage1/final_draft.md
stage2_input:
  entry_type: stage2_flow
  final_draft_path: C:/Demo/output/request-a/stage1/final_draft.md
  intermediate_dir: C:/Demo/output/request-a/stage2/intermediate/
stage2_result:
  formatted_output_path: C:/Demo/output/request-a/stage2/formatted-sales.html
  output_format: html
stage3_input:
  html_output_path: C:/Demo/output/request-a/stage2/formatted-sales.html
pipeline_state:
  output_docx_path: C:/Demo/sales-report.docx
```

S1 的相对路径以本次请求目录为基准，交给 S2 前展开；`intermediate_dir` 由编排层预建。这里每个字段都有消费方，因而可以定位开头的旧版 DOCX 假设：若修正稿已经写入新路径，但 S3 仍读取旧 HTML，错误发生在版本交接。路径字符串存在不代表对应文件已更新；文件改名也必须把实际路径写回。converter 返回转换状态与预览状态，供编排层继续记录。[`agents/doc-formatter.md` L30—49：S60](https://jiuchenm.github.io/workbuddy-study/#S60)、[`agents/doc-converter.md` L114—168：S61](https://jiuchenm.github.io/workbuddy-study/#S61)

这条链有入口边界。已有文档的抽象全文美化从 S2 开始；指定字体或修改某段回到编辑路线。无已有文档、有创作意图、目标短于 1000 字时，优先进入 `brief-compose`：直接撰稿并生成 HTML，再转换和预览。若本例只要求约 600 字说明，应走短篇流程。角色也不等于独立进程：orchestrator L140—158 默认在同一执行上下文中切换角色，仅在用户强制要求时使用独立 subagent。它们都属于 Skill 约定，实际走了哪条路线仍需运行记录。[短篇约定 `brief-compose/SKILL.md` L13—39：S17](https://jiuchenm.github.io/workbuddy-study/#S17)

## 审计记录和质量检查证明不同的事

`pipeline-state.yaml` 记录阶段、实际产物路径、降级原因和预览状态。`tdoc-orchestrator/references/pipeline-state-protocol.md` 明确把它定义为 audit trail，即便于事后追查的审计记录；按约定单写者顺序更新，先写 YAML 再声明完成检查点。它没有借此提供执行锁、原子事务或自动恢复引擎。[协议 L1—108：S43](https://jiuchenm.github.io/workbuddy-study/#S43)

结束时的 `consistency_check` 要实际检查文件存在且非空，并核对链上阶段是否完成。不过 L153—167 同时规定检查失败也不阻塞交付，只记录错误。因此 `current_stage: completed` 描述阶段推进，文件存在检查描述磁盘状态，质量检查描述指定版本满足了哪些规则。非空 DOCX 仍可能缺段落；“已打开预览”也没有提供版式复核结果。

HTML 质量检查有实际脚本判据。`skills/html-review/scripts/review_html.py` L763—838 的 `review` 汇总五项得分：设计 token 合规、结构、排版、文体、装饰，权重依次为 25%、25%、20%、20%、10%；安全检查是第六项，不参与平均，而是独立通过条件。总分四舍五入后至少 80，前五维各自通过且安全项通过，整体 `passed` 才为真。[实际评分与退出语义：S25](https://jiuchenm.github.io/workbuddy-study/#S25)

手算一个假设反例：前五项为 100、100、100、70、100，加权总分为 `100×0.25 + 100×0.25 + 100×0.20 + 70×0.20 + 100×0.10 = 94`。但文体检查可因缺少一个必要元素返回 `score: 70, passed: false`，整体仍失败。平均分没有覆盖独立门槛；这些规则也无法独立核实经营解释是否有数据支持。脚本入口对通过返回 0、不通过返回 1、读不到文件或空输入返回 2，调用方需要按此协议解释结果。

假设销售报告的 HTML 得到上述 94 分，随后缺失元素已补上。`skills/html-review/SKILL.md` L23、L103—114 规定检测失败后只作一次定向修正，直接输出，不再复检。于是第一次报告只描述修正前的 HTML，修正后的质量仍未知。formatter 还允许检查脚本异常时输出当前最佳 HTML，记录 `review_skill_failed`。转换成功只能说明转换结果，不能把这些未验证状态清掉。[修正策略：S24](https://jiuchenm.github.io/workbuddy-study/#S24)、[formatter 异常表 L204—211：S60](https://jiuchenm.github.io/workbuddy-study/#S60)

## 表格重算不能只看退出码

回到独立 `summary.xlsx`：假设 B2 写入 200、B3 写入 50，总额 B4 写入 `=SUM(B2:B3)`。公式字符串说明如何计算，缓存值保存上一次计算的结果；有些读取方或预览器只读缓存。写入公式后若没有得到缓存，文件即使存在，也可能显示空白。`skills/excel-generation/SKILL.md` L158—188 因此要求含公式时重算并读取结构化结果。直接写入数值的任务则可读回核对，不需要为了形式补跑重算。[生成流程约定：S26](https://jiuchenm.github.io/workbuddy-study/#S26)

实际 `skills/excel-generation/scripts/recalc.py` 的 `recalc` 先尝试 LibreOffice，失败后尝试 Python `formulas` 引擎求值并回填缓存；两者都未能取得完整缓存时，只能静态分析，返回 `error` 和 `engine: static`。静态层即使没找到明显结构错误，也不能证明已经算出结果。`engine` 标记实际走到哪层，结果还要分为 `status: success`、`status: errors_found` 和顶层 `error`：分别表示扫描未见公式错误、已经发现公式错误、没有完成所需重算。[脚本 L690—793：S62](https://jiuchenm.github.io/workbuddy-study/#S62)

它的 `main` 仅在结果含 `error` 时非零退出，所以 `errors_found` 也会 exit 0。与 HTML review 对照，前者可以成功完成“发现错误”的检查，后者用退出码区分通过与不通过。调用方需要读取各自返回协议。本例应先确认 `status: success`、`total_errors: 0`，再核对业务期望值 250：如果公式误写成 `=SUM(B2)`，得到的 200 没有公式错误码，却漏掉华南销售。**公式检查与业务验算分别回答能否求值和算的是否是用户要的数。**

## 保存与展示是最后的独立动作

原位编辑还有内存与磁盘的距离。SheetAgent 的 `hooks/hooks.json` 把保存脚本接到 `SubagentStop`；`hooks/save-on-subagent-stop.mjs` L149—198 查询编辑器池，对 `is_dirty` 且有 `file_id` 的实例调用保存。`saveWithRetry` 对占用错误最多尝试三次，每次间隔 1.5 秒；其他错误或调用异常不会无限重试。这是补充保存动作，不能替代汇总内容检查。[保存 Hook L101—207：S27](https://jiuchenm.github.io/workbuddy-study/#S27)

单文件保存失败时脚本只记录 `unsaved`，外层异常也只记录 `fatal`，随后仍执行 `process.exit(0)`。所以“Hook 进程成功结束”不证明所有脏文件已保存。对于 sales.xlsx，最终需要看到目标实例的保存结果，不能拿子 Agent 的完成文本或 Hook 的退出码代替。保存脚本遍历的是池中的脏实例，没有从用户请求推导出唯一目标文件。

DOCX 路线约定转换成功后立即用 `present_files` 打开最终文件，并记录 `present_files_opened`。假设报告转换成功但预览失败，可以说明文件已生成，同时保留预览尚未完成；按该契约，也不能声明 S3 全部完成。转换失败则返回错误和 Markdown 或 HTML 降级信息，不能把备用内容当成已生成的 DOCX。[转换结果与出口：S61](https://jiuchenm.github.io/workbuddy-study/#S61)

用户最终收到的交付说明应让他找到实际文件，并知道哪些条件已经确认。销售表需要对应正确工作簿、包含 200/50/250、公式结果可读取，原位编辑还需要目标实例保存成功。报告需要沿最新内容稿与 HTML 转换，保留修正后未复检等质量状态，再分别确认文件和预览结果。这样，每个验收结论都指向具体对象与版本；未解决的失败仍能被下一步处理。

<details>
<summary>面试怎么回答</summary>

**一分钟回答：** 文档 Agent 的任务要交付正确文件，所以先确定要生成新的 xlsx 还是修改原工作簿，再把路径、编辑器 ID 和原始请求交清。DOCX 创作按 Markdown、HTML、DOCX 连接阶段，编排层传实际路径；短篇有优先流程，阶段角色也不一定是独立 subagent。验收分别看业务内容、质量检查、重算、保存和预览。pipeline-state 只是审计记录，HTML 修正后未复检不能称通过，重算 exit 0 可能仍有公式错误，保存 Hook exit 0 也可能留下未保存文件。这是 5.6.2 安装材料的静态分析，运行效果还需实际证据。

**追问一：为什么有路径还要 file_id？** 路径定位磁盘文件，ID 定位当前工具要操作的编辑器实例。两者需要由解析工具建立对应关系，不能让模型自行猜测。安装材料的三层交接约定存在分歧，应检查字段实际传递与最终操作对象。

**追问二：为什么 completed 不能代表验收通过？** completed 往往只描述阶段推进。审计一致性检查可以非阻塞，修正后的 HTML 可能未复检，保存也可能失败。验收必须指明检查对象的版本和返回结果，才能知道哪个结论有证据。

**追问三：云文档能直接复用这套本地流程吗？** 要先确认交付对象。本地 file_id 指编辑器实例；云文档 Skill 面向特定平台和服务，需要查询工具参数并使用宿主提供的鉴权。安装了能力说明没有证明当前会话具有票据、权限或已成功写入云文档。

</details>

练习：假设新表的重算命令 exit 0，但 JSON 为 `status: errors_found, total_errors: 1`；原表保存 Hook 也 exit 0，日志含 `unsaved`；报告 HTML 首次评分 94，但文体项失败，修正一次后生成了 DOCX。三份产物分别能声明什么，下一步应核查什么？

<details>
<summary>练习参考思路</summary>

新表只能说检查完成且发现公式错误，应根据错误定位修正并重算，再核对 250 等业务期望。原表只能说编辑流程结束，不能说修改已保存，要核对目标 file_id 的保存结果并处理未保存原因。DOCX 可以在实际转换成功时声明已生成，但 HTML 只完成一次修正，没有复检通过证据；还需分别说明预览是否成功。三者都不能用进程或阶段结束替代对应产物的验收结论。

</details>
