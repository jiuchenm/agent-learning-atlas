# WorkBuddy：长对话怎样整理历史、压缩并继续执行

假设 WorkBuddy 正在修复订单导出脚本。对话里已有几轮文件读取、一段很长的日志、一次取消的请求，以及成功和未完成的工具调用。用户说“继续检查分页”，模型下一轮需要知道哪些结论仍有效，也需要避免把取消的要求重新当成任务。直接把历史数组全部发送出去，既浪费窗口，也可能带入不属于当前执行分支的内容。

先读 [上下文压缩](#/lesson/compact)，可以了解压缩为何有损。本篇只跟踪 WorkBuddy 5.6.2 安装包中 `cli/dist/codebuddy-lite-wb.mjs` 的具体实现，核验日期为 2026-09-28。它是随包交付的代码，不代表已确认当前桌面会话使用这个 bundle。所有历史、文件路径和结果均为假设；本次没有执行供应商代码、读取真实聊天或发起压缩。[公开证据目录](https://jiuchenm.github.io/workbuddy-study/#S28)提供定位，未公开源码全文。由于 bundle 一行可能包含多个函数，下文同时保留行号与必要列号。

## 进入模型前，先确定哪段历史还属于当前任务

假设存储中的历史按以下顺序排列，条目 ID 和 parentId 能连接成同一活动分支；没有更早的压缩边界，也没有会话分隔符。表中只展示与机制有关的内容，不是产品的完整消息格式。

| 条目 | 假设内容与状态 |
| --- | --- |
| U0 | 修复 `C:/demo/orders/export.py` 的分页；隐含 user-context 说明保留 CSV 字段顺序 |
| C1 / R1 | Read 调用与对应结果；结果包含很长的旧文件内容 |
| A1 | 已完成的助手消息：发现没有跟随 next_cursor，尚未修改文件 |
| U2 | 用户临时要求先统计测试样例，随后取消 |
| C2 / R2 | 取消前已完成的 Read 调用及结果；没有其他已完成的助手回答 |
| I2 | 对应中断标记，`skipRun=true`，父链可追到 U2 |
| U3 | 用户改为继续检查分页，先运行本地测试 |
| C3 | 测试调用已记录，结果缺失，不能判断成功或失败 |

`HistoryAgentRunInterceptor` 在输入为数组且未设置 skipAddHistory 时，先按条件加入新历史，再取得活动分支并去掉自定义条目，处理会话分隔符。接下来依次筛选取消的 prompt、压缩边界、任务范围、已截断条目和特定 API 错误消息，再修复工具调用与结果关系。先找分支再做内容过滤，意味着“文件中出现过”不等于“这次模型会看到”。（`HistoryAgentRunInterceptor`，L113 C2440–4700；[S28 定位](https://jiuchenm.github.io/workbuddy-study/#S28)。）

活动历史依赖 lastMessageId、parentId 等关系，并在特定条件下使用 logicalParentId。边界处理也不只有一种：会话分隔符之前的记录可以排除，已有压缩条目之前的历史也可能退出当前输入。所以不能把它简化成“永远保留最近若干条”。本例排除了这些额外边界，才能单独观察取消和工具关系。（`HistoryUtils.getActiveHistory`，L2572 C25303；`getCompactionBoundaryHistory`，L2572 C26249；[S57 相关定位](https://jiuchenm.github.io/workbuddy-study/#S57)。）

## 取消一轮，不等于抹掉这一轮已经发生的操作

`filterCancelledPromptHistory` 找到特定中断标记后，要求其 skipRun 为 true，沿父链找真实用户消息，并确认两者之间没有已完成的助手消息，才过滤这段范围内的相关消息。本例满足这些条件，U2 和 I2 可以离开下一次输入；C2、R2 却保留，因为代码显式豁免 `function_call` 与 `function_call_result`。如果中间已有完成回答，不能再按本例推断整段会被筛掉。（L2576 C1132，`filterCancelledPromptHistory`；[S57 定位](https://jiuchenm.github.io/workbuddy-study/#S57)。）

保留工具关系有实际含义：取消表达“不再按原请求继续”，并不能证明此前读取、写入或外部提交没有发生。本例只是读取样例；若替换为已经写文件的调用，删除模型上下文里的用户句子也不会还原文件。这段函数只处理历史视图，没有回滚业务状态。其类型判断也有明确范围，不能把对这两个内部类型的处理扩展成所有 provider 格式。

随后 `fillFunctionCallResultHistory` 用 callId 匹配结果，去除重复调用、重复结果和没有对应调用的结果，并把结果放到对应调用批次后面。本例 C1/R1、C2/R2 仍有对应关系；C3 缺少结果时，会补一个输出为空、status 为 incomplete、skipRun 为 true 的结果。这个补项表示协议关系得到补齐，不是补出一次成功测试。（L2576 C3429，`fillFunctionCallResultHistory`；[S57 定位](https://jiuchenm.github.io/workbuddy-study/#S57)。）

经过这两步，假设的普通模型输入可以概括为 U0、C1/R1、A1、C2/R2、U3、C3/未完成补项。语义应该是：分页问题仍待修复；取消的样例统计不再是当前要求；已有读取事实仍在；测试状态未知。若模型把空结果理解为“零个失败用例”，就是错误解释，历史修复本身没有支持这个结论。

## 工程压缩与模型摘要，丢掉的内容不一样

需要进一步减小历史时，可见实现包含工程压缩（engineering compaction）和模型摘要。前者由普通程序按规则改写文本，不要求模型理解任务。`HistoryEngineeringCompactor` 先取压缩边界后的历史，保留用户与助手文本，改写工具调用表示；它跳过 `function_call_result` 等类型，把工具结果标成 omitted，并隐藏参数中的 content、widget_code、new_string 字段。因此一个 Write 调用可以还留下文件路径，却不再保留当时写入的完整正文。（L335 C33112 至 L353 C903；[S58 定位](https://jiuchenm.github.io/workbuddy-study/#S58)。）

应用到本例时，A1 中“没有跟随 next_cursor，尚未修改”这一结论若位于保留范围，仍可能作为普通文本留下；R1 的大段源码则不会以原工具结果继续保留。C3 的参数可以留下，但其未完成状态也不能仅靠省略后的结果恢复。后续需要精确源码或测试状态，就要重新读取文件或查询原记录，不能把 omitted 当作空内容或成功。

这里还有一个调用链差别：PreMessage 策略把 session.history 直接交给工程压缩器，工程函数本身没有调用取消过滤器。因此不能说“上一节普通模型输入过滤掉 U2，所以所有压缩路径也已经删除 U2”。不同入口可能用不同中间表示。下面是原创、简化的语义对照，不是运行输出，也不承诺真实摘要逐字如此：

```text
普通输入筛选：取消的 U2 可被过滤，C2/R2 保留，C3 补 incomplete 结果。
工程压缩表示：保存选中范围的用户/助手文字和工具名、部分参数；结果省略。
需要的任务交接：分页未修复，字段顺序不变，测试结果未知；取消请求不能复活。
```

PreMessage 会比较工程压缩的估算体积与目标。足够小时直接采用，不调用 LLM；仍过大时才调用 CONTEXT_SUMMARY。摘要为空或调用失败，就尝试保留最近五个真实用户轮次后再工程压缩；该回退仍没有内容时，最后采用原工程结果。这里的“估算 token”由字符长度粗略换算，并非 tokenizer 的精确测量；最后一条回退也没有证明输入必定已降到目标以下。（L356 C6087–10385，`doPreMessageCompactionCore`、`runLlmSummaryForPreMessage`；[S59 定位](https://jiuchenm.github.io/workbuddy-study/#S59)。）

另一个 COMPACT agent 入口还会先做 microcompact：对指定工具类型保留最近五个结果，对更旧结果清除正文，并对保留项作长度截断，随后处理图片与隐藏 reminder。这里的“五个工具结果”与上面的“五个用户轮次”不是同一个计数单位，更不能泛称所有 WorkBuddy 压缩都保留最近五轮。（L113 C3500 附近；`MessageUtils.performMicrocompact` L2712 C12120–L2714；[S65 定位](https://jiuchenm.github.io/workbuddy-study/#S65)。）

## 摘要失败或被取消时，不能照常宣告继续

紧急超长路径 MaxToken 的处理更像一次受控替换。它先保存原历史数组的条目和 lastMessageId，停止当前流，再裁到合适边界调用摘要。第一次失败或返回空内容，且会话仍在压缩、未被取消时，会把最后一批工具结果换成截断占位，再重试摘要。这不是把调用本身当作没发生，而是减少送入摘要器的结果体积。（L356 C10574 起至 L358 C4400，MaxToken strategy；[S29 定位](https://jiuchenm.github.io/workbuddy-study/#S29)。）

重试仍失败时，代码可用最近五个用户轮次作工程回退；摘要和工程回退都拿不到内容，则调用 restoreOriginalHistory，还原数组成员和 lastMessageId，返回失败，并跳过 sendContinueMessage。即使已经拿到摘要，在替换历史前发现取消，也会走恢复分支。这个恢复范围是历史引用及游标，不是撤销工具副作用，更不是证明所有对象内部字段都经过深拷贝回滚。

成功路径也先恢复原历史，再通过 addHistory 增加带 isCompacted、isCompactInternal、isSummary 等元数据的压缩条目。`markCompactionComplete` 更新压缩时间、hasCompactedHistory，并发出历史重载通知。后续输入按边界使用新条目，不必把整个存储文件物理删除。因此“替换活动上下文”和“销毁旧记录”不能混写。压缩完成后，续跑请求仍可能失败；sendContinueMessage 返回 false 时，代码不会把“摘要完成”自动变成“主任务恢复成功”。

Blocking 策略的失败处理又不同：等待不到结果、结果不是流、没有可提取摘要或用户取消，都有专门判断。`restoreSessionStateAfterFailedCompact` 主要恢复 resultSubject 与 lastMessageId，并非 MaxToken 那个数组恢复函数。部分超长错误还会交给后续截断处理。不能用其中一个函数概括所有故障都完整回滚。（L358 C5639–14000，Blocking strategy；`sendContinueMessage` L353 C3300 附近；[S29 定位](https://jiuchenm.github.io/workbuddy-study/#S29)。）

## 压缩后如何找回 user-context，并继续原任务

普通 agent 的历史拦截器会把 COMPACT agent 的工作条目换成提取出的摘要。当输入包含内部压缩用户消息时，它还从 session.history 提取 user-context；若当前输入没有这段内容，就在首条消息位置补一个 system reminder。这解释了为什么隐藏身份或约束不必只靠摘要器记住。（L113 C4142–4700；`extractUserContextFromHistory`、`containsUserContext` L2576 C404–1066；[S28](https://jiuchenm.github.io/workbuddy-study/#S28)、[S57 定位](https://jiuchenm.github.io/workbuddy-study/#S57)。）

不过，提取依赖原历史里还有能匹配的用户上下文，查重也依据提取出的文本是否已存在。它不是“任何规则永远不会丢失”的保证。本例如果保留字段顺序只写在一条被删掉的普通对话里，而没有进入可恢复上下文或摘要，就仍可能丢失。继续请求只是让模型基于整理后的历史工作；恢复出的目标、约束和测试状态是否正确，还需要与证据核对。

长期 Memory 是另一种状态。安装包的 memory Prompt 片段区分云端资料、用户级本地记忆和项目记忆，并规定各自写入范围。这些是供模型遵循的约定，发现模板不代表当前会话已经加载，也不证明记忆写入执行成功。本例的 export.py、测试日志和实际导出任务仍有各自的持久状态；上下文变短不会把它们清空。恢复执行时如何避免重复动作，可继续读 [WorkBuddy 会话恢复](#/lesson/workbuddy-recovery)。（`resources/plugins/workbuddy-builtin/prompt-common/fragments/workbuddy-memory-system.md` L1–58；[S30 定位](https://jiuchenm.github.io/workbuddy-study/#S30)。）

<details>
<summary>面试怎么回答</summary>

**一分钟回答：** 这份 WorkBuddy 实现先按活动分支和边界整理历史，过滤符合条件的取消消息，并修复工具调用与结果关系。缺失结果只能补 incomplete，不能补成功。压缩有工程改写和模型摘要等路径：工程改写会省略工具结果，模型摘要也可能漏信息。超长处理包含重试、最近轮次回退，以及失败或取消时恢复历史的分支。成功后写入压缩边界，再请求续跑；压缩成功和续跑成功需要分别判断。user-context 可以从历史补回，长期 Memory 和文件状态则独立存在。

**追问一：取消了请求，为什么还保留工具调用？** 取消不能证明之前的操作没有发生。已执行工具有事实与副作用，保留调用关系有助于避免误判；该取消过滤器也明确豁免特定内部工具类型。它不负责业务回滚。

**追问二：工程压缩不调用模型，是否就无损且更可靠？** 它按规则省略结果和部分参数，信息损失十分明确。程序执行可预测，不代表任务语义完整；尤其成功状态只存在于工具结果时，省略后必须重新查证。本次没有测量速度或实际任务质量。

</details>

练习：本例 C3 的测试其实已经在外部进程结束，但结果尚未写回历史。MaxToken 摘要第一次为空，重试也失败；工程回退得到内容后，用户在替换历史前取消。应用能否补“测试通过”、继续运行测试或声称压缩完成？下一次用户要求继续时应查什么？

<details>
<summary>练习参考思路</summary>

不能补测试通过，缺失结果只支持未完成或未知。按已读 MaxToken 分支，替换前发现取消应恢复原历史成员和 lastMessageId，返回失败，不进入正常续跑。外部进程的完成状态不会因历史恢复而改变。下次应先核对原测试进程或输出文件，确认它针对哪个文件版本运行，再决定是否需要重跑；不能把历史缺失解释为测试从未执行。具体进程查询与重复执行控制不由这段压缩代码保证。

</details>
