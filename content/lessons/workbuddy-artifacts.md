# WorkBuddy：文档与表格任务怎样交接和验收

假设用户给出一份销售工作簿，说“按地区汇总”。助手算出了正确总额，却把结果另存成新文件，而用户期待在原文件增加一个 sheet；另一位助手生成了 DOCX，回复“已完成”，用户打开才发现它仍是修正前的版本。这些错误不一定发生在模型计算或写作时，也可能发生在交接对象、目标路径或完成判据上。

WorkBuddy 的文档流程把这些责任分散在路由 Skill、领域角色、脚本和保存 Hook 中。本篇依据 2026-09-28 读取的 WorkBuddy 5.6.2 安装材料，解释它们怎样配合，以及哪些约定没有形成强制保证。可先读 [Skill 从发现到执行](#/lesson/workbuddy-skills)。以下例子均为假设，没有打开业务文件或运行供应商程序；来源链接是[安装材料定位索引](https://jiuchenm.github.io/workbuddy-study/#S12)，不是公开源码。下文 entry 省略共同前缀 `resources/plugins/workbuddy-builtin/`。

## 先决定交付哪一个文件

“汇总成一张新表”存在两种不同含义：新工作簿是磁盘上的另一个 `.xlsx`，新 sheet 则可能仍在原工作簿里。`skills/tencent-docs-routing/SKILL.md` L45—68 用交付物身份区分它们：只有用户要独立的新文件、原材料只读、最终路径不同于源文件时，才进入 `tencent-docs-sheet-generation`；在原文件添加汇总 sheet 属于原位修改。附件是不是 Excel，并不能单独决定路线。[Office 路由：S12](https://jiuchenm.github.io/workbuddy-study/#S12)

假设 `C:/Demo/sales.xlsx` 里有三笔销售额：华东 120、华东 80、华南 50。用户说“另做 `C:/Demo/summary.xlsx`”，应保留源文件，生成独立工作簿；用户说“在 sales.xlsx 增加地区汇总 sheet”，最终交付对象仍是 sales.xlsx。两种任务的手算结果相同：华东 200、华南 50、总额 250，但它们允许写入的对象不同。计算正确不能弥补改错文件。

对于原工作簿，该路由还区分确定性小修改和依赖数据理解的任务。把指定单元格改成给定值，可以从请求确定动作；按地区汇总则需要发现表头、识别记录、决定范围，进入 sheet-agent 路线。L116—118 要求原子委派（atomic delegation）：把完整任务一次交出去，主层只能先解析文件身份，不能先读一部分、写一部分，再把余下工作交给领域 Agent。这里的“原子”指任务责任不被拆散，并不表示数据库事务，也没有承诺失败回滚。

## 路径和编辑器身份必须一同交清

路径表示磁盘对象；`file_id` 在路由约定中标识一个已经打开的本地编辑器实例。即使某一实现暂时用绝对路径作 ID，也应消费工具返回的身份，而不是让模型从文件名拼出来。窗口当前显示哪个文件、磁盘上哪个文件待交付、工具操作哪个实例，是需要保持一致的三个问题。[同一 router L140—146：S12](https://jiuchenm.github.io/workbuddy-study/#S12)

这一段安装材料恰好留下了可检查的交接分歧。上层 router 要求主层先取得 live `file_id`，把 ID、绝对路径和用户原始请求传下去，并禁止子 Agent 自行解析；中间的 `builtin-plugins/sheetagent/skills/excel-handler/SKILL.md` L18—29 却只列路径、原始需求、当前时间、期望返回四项；下层 `agents/sheet-agent.md` L43—79 又允许缺少 ID 时调用 `resolve_local_excel` 解析路径或默认实例。[中间交接：S13](https://jiuchenm.github.io/workbuddy-study/#S13)、[下层解析：S14](https://jiuchenm.github.io/workbuddy-study/#S14)

因此，不能把这些文件拼成一份毫无矛盾的运行保证，也不能仅凭静态分歧断言实际任务已经失败。它指出了应观察的断点：ID 在哪一层产生，handler 是否传递，子层是否重复解析，最终保存是否仍指向原对象。对前面的原位汇总假设，可靠的交接应保留工具返回的真实 ID、`C:/Demo/sales.xlsx` 和完整原始请求；这是据分歧提出的工程要求，不是本次执行记录。若缺字段，应修复交接契约，不能把猜出一个看似合理的 ID 当成恢复。

## DOCX 用产物类型连接阶段

文档创作的交接还多了一层：上一步产生的东西，下一步是否能消费。`builtin-plugins/tencent-docx/skills/tdoc-orchestrator/SKILL.md` L32—65 定义 S1 从意图生成 Markdown，S2 从内容生成 HTML，S3 把 HTML 转为 DOCX 并触发预览。这里的类型化交接（typed handoff）是明确规定字段和产物格式，不能直接等同于编译器已经实施了类型检查。[DOCX 编排：S16](https://jiuchenm.github.io/workbuddy-study/#S16)

例如，假设用户另起一轮，直接在消息中给出华东 200、华南 50、合计 250，要求从零写一份约 1500 字的经营说明并交付 DOCX，不附已有文档。S1 负责形成内容稿；S2 接收其 `final_draft_path`，而不是重新猜一份文字；S2 返回的 `formatted_output_path` 必须是 HTML，编排层把它映射到 S3 的 `html_output_path`。目标 DOCX 的绝对路径已在 Stage 0 写入 `pipeline-state.yaml`，converter 启动时读取，避免各阶段各自决定保存位置。下面是字段对应的教学示意，并非实际执行输出：

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

示意中的 S1 相对路径以本次请求目录为基准，交给 S2 前展开到明确位置；`intermediate_dir` 由编排层预建。formatter 解释内容和版式，orchestrator 映射跨阶段字段，converter 使用已确定路径转换，并返回转换状态和预览状态。换文件名时，也要把实际路径写回，不能留下一个磁盘上根本没有的占位文件名。[`agents/doc-formatter.md` L30—49：S60](https://jiuchenm.github.io/workbuddy-study/#S60)、[`agents/doc-converter.md` L114—168：S61](https://jiuchenm.github.io/workbuddy-study/#S61)

这条完整链不是所有 DOCX 请求的固定流程。已有文档的抽象全文美化可以从 S2 开始；指定字体或修改某段内容会回到编辑路线。更早的优先规则是：无已有文档、具有创作意图、目标短于 1000 字时，进入 `brief-compose`，直接撰稿并生成 HTML，再转换和预览，不继续常规角色编排。若只是要求一份约 600 字说明，就不应为了凑齐三阶段而多跑 S1/S2。角色也不等于独立进程：orchestrator L140—158 默认要求同一执行上下文中的角色切换，仅在用户强制要求时采用独立 subagent。[短篇约定 `brief-compose/SKILL.md` L13—39：S17](https://jiuchenm.github.io/workbuddy-study/#S17)

## 审计记录和质量检查证明不同的事

`pipeline-state.yaml` 记录阶段、实际产物路径、降级原因和预览状态。`tdoc-orchestrator/references/pipeline-state-protocol.md` 明确把它定义为 audit trail，即便于事后追查的审计记录；按约定单写者顺序更新，先写 YAML 再声明完成检查点。它没有借此提供执行锁、原子事务或自动恢复引擎。[协议 L1—108：S43](https://jiuchenm.github.io/workbuddy-study/#S43)

结束时的 `consistency_check` 要实际检查文件存在且非空，并核对链上阶段是否完成。不过 L153—167 同时规定检查失败也不阻塞交付，只记录错误。因此 `current_stage: completed`、文件存在、检查通过，是不同状态。一个非空 DOCX 也可能缺段落；“已调用预览”只说明打开动作发生，不能证明有人检查过版式。状态字段的价值在于保留事实，不能靠把它们统一写成 completed 来补足证据。

HTML 质量检查则有实际脚本判据。`skills/html-review/scripts/review_html.py` L763—838 的 `review` 汇总五项得分：设计 token 合规、结构、排版、文体、装饰，权重依次为 25%、25%、20%、20%、10%；安全检查是第六项，不参与平均，而是独立通过条件。总分四舍五入后至少 80，前五维各自通过且安全项通过，整体 `passed` 才为真。[实际评分与退出语义：S25](https://jiuchenm.github.io/workbuddy-study/#S25)

手算一个假设反例：前五项分别为 100、100、100、70、100，加权总分是 94。但代码中文体检查可能因缺少必要元素返回 `score: 70, passed: false`，于是总分再高也不能通过。这能防止平均分掩盖某项失败，却不证明文档事实正确；脚本能检查结构规则，不能独立核实经营解释是否有数据支持。运行入口对通过返回 0、不通过返回 1，读不到文件或空输入返回 2，调用方应保留这些区别。

还要分清检测前后两个版本。`skills/html-review/SKILL.md` L23、L103—114 规定检测失败后给上游一次定向修正，修正后直接输出，不再复检。这限制了修正成本，也留下质量未知：第一次报告只描述旧 HTML，不能把“已修改”写成“复检通过”。formatter 的失败分支还允许检查脚本异常时输出当前最佳 HTML，并记录 `review_skill_failed`。这些降级都应随产物传递，而不是在转换成功时被抹去。[修正策略：S24](https://jiuchenm.github.io/workbuddy-study/#S24)、[formatter 异常表 L204—211：S60](https://jiuchenm.github.io/workbuddy-study/#S60)

## 表格重算不能只看退出码

回到生成独立 `summary.xlsx` 的假设。若写入的是数值 200 和 50，结果可以直接读回核对；若写入公式，总额单元格只是 `=SUM(B2:B3)` 这样的表达式，预览器还可能需要缓存结果。`skills/excel-generation/SKILL.md` L158—188 要求含公式时重算，并读取结构化结果。[生成流程约定：S26](https://jiuchenm.github.io/workbuddy-study/#S26)

实际 `skills/excel-generation/scripts/recalc.py` 的 `recalc` 先尝试 LibreOffice，失败后尝试 Python `formulas` 引擎求值并回填缓存；两者都未能取得完整缓存时，只能静态分析，返回 `error`。静态层即使没找到明显结构错误，也不能证明已经算出结果。`engine` 标记实际走到哪层，结果还要分为 `status: success`、`status: errors_found` 和顶层 `error`：分别表示扫描未见公式错误、已经发现公式错误、没有完成所需重算。[脚本 L690—793：S62](https://jiuchenm.github.io/workbuddy-study/#S62)

它的 `main` 仅在结果含 `error` 时非零退出，所以 `errors_found` 也会 exit 0。这个设计与 HTML review 不同：前者的进程成功可以表示“成功完成了一次发现错误的检查”，后者的退出码直接区分通过与不通过。调用方需要读各自协议，不能写一个通用的“exit 0 就交付”。本例应确认重算成功、`total_errors` 为零，再核对业务期望值 250。即使公式没有报错，误写成只求和 B2 得到 200 仍可能通过错误码扫描；业务验算负责发现这类范围错误。

## 保存与展示是最后的独立动作

原位编辑还有内存与磁盘的距离。SheetAgent 的 `hooks/hooks.json` 把保存脚本接到 `SubagentStop`；`hooks/save-on-subagent-stop.mjs` L149—198 查询编辑器池，对 `is_dirty` 且有 `file_id` 的实例调用保存。`saveWithRetry` 对占用错误最多尝试三次，每次间隔 1.5 秒；其他错误或调用异常不会无限重试。这是补充保存动作，不能替代汇总内容检查。[保存 Hook L101—207：S27](https://jiuchenm.github.io/workbuddy-study/#S27)

更关键的是，单文件保存失败时脚本只记录 `unsaved`，外层异常也只记录 `fatal`，随后仍执行 `process.exit(0)`。所以“Hook 进程成功结束”不证明所有脏文件已保存。对于 sales.xlsx，最终需要看到目标实例的保存结果，不能拿子 Agent 的完成文本或 Hook 的退出码代替。保存脚本的遍历对象是池中的脏实例，也不是从用户请求自动推导出的唯一目标文件。

DOCX 路线则约定转换成功后立即用 `present_files` 打开最终文件，并记录 `present_files_opened`。假设报告已经转换，但预览失败，就应分别保留“文件已生成”和“预览尚未完成”；若 HTML 经过一次修改却未复检，还要保留这一质量状态。一个可信交付需要说明实际文件在哪里、哪项检查做过、是否成功保存和展示。每个证据回答一个问题，不能让最后一句“完成”吞掉中途仍未解决的状态。

<details>
<summary>面试怎么回答</summary>

**一分钟回答：** 文档 Agent 先确定交付物身份：生成新的 xlsx 与在原工作簿增加 sheet 是不同路线。交接时既要有真实路径，也要有工具返回的编辑器 ID；DOCX 则按 Markdown、HTML、DOCX 的产物类型连接阶段，但短篇有优先路径，角色不一定是独立 subagent。验收要区分业务结果、脚本检查、保存和预览。pipeline-state 是审计记录；HTML 修正后未复检不能称通过；重算 exit 0 可能仍有公式错误；保存 Hook exit 0 也可能留下未保存文件。

**追问一：为什么有路径还要 file_id？** 路径定位磁盘文件，ID 定位当前工具要操作的编辑器实例。两者需要由解析工具建立对应关系，不能让模型自行猜测。安装材料的三层交接约定存在分歧，应检查字段实际传递与最终操作对象。

**追问二：为什么 completed 不能代表验收通过？** completed 往往只描述阶段推进。审计一致性检查可以非阻塞，修正后的 HTML 可能未复检，保存也可能失败。验收必须指明检查对象的版本和返回结果，才能知道哪个结论有证据。

</details>

练习：假设新表的重算命令 exit 0，但 JSON 为 `status: errors_found, total_errors: 1`；原表保存 Hook 也 exit 0，日志含 `unsaved`；报告 HTML 首次评分 94，但文体项失败，修正一次后生成了 DOCX。三份产物分别能声明什么，下一步应核查什么？

<details>
<summary>练习参考思路</summary>

新表只能说检查完成且发现公式错误，应根据错误定位修正并重算，再核对 250 等业务期望。原表只能说编辑流程结束，不能说修改已保存，要核对目标 file_id 的保存结果并处理未保存原因。DOCX 可以在实际转换成功时声明已生成，但 HTML 只完成一次修正，没有复检通过证据；还需分别说明预览是否成功。三者都不能用进程或阶段结束替代对应产物的验收结论。

</details>
