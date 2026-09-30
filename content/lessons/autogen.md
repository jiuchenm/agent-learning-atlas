# AutoGen：用消息与团队组织多 Agent 协作

用户要一份订单回复。查询者找到配送状态并起草，检查者发现草稿写了没有依据的送达日期，查询者改稿后再送检。一个 Agent 也可以尝试完成这些事；当查询、写作与检查需要不同的工具或独立判断时，还要回答新的工程问题：**参与者之间传什么、下一位由谁来做、怎样知道结果可以交付？**

AutoGen 是 Microsoft 开源的多 Agent 应用框架，提供 Agent 收发消息、使用模型和工具，以及把多个 Agent 组成团队的接口。这里的 Agent 是接收输入、处理并作出响应的程序组件；它可以调用 LLM，也可以运行普通代码。**AutoGen 组织协作过程，业务事实、权限和交付标准仍由应用提供。**官方建议初学者从 AgentChat 的团队接口入手；Core 提供更底层的事件驱动消息机制。[AutoGen AgentChat](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/index.html)、[AutoGen Core](https://microsoft.github.io/autogen/stable/user-guide/core-user-guide/index.html)

本文用一份**教学假设**的 O42 订单回复，先走完消息流，再解释 AgentChat、Core、停止和评估。订单、工具结果和成员发言均为构造，没有实际调用 AutoGen 或订单系统。分工的收益与成本见[多 Agent](#/lesson/multi-agent)，跨次运行的状态见[任务状态](#/lesson/agent-state)。产品机制按 **2026-09-30** 查阅的 AutoGen stable 文档描述；stable 入口会更新，实际编码应锁定安装版本，避免混用旧 v0.2 示例。

## 一次协作先怎样发生

用户输入：“查询订单 O42 的配送进度，写一份待审核的回复草稿。”本例只允许读订单，不允许改配送或发送给客户。团队有两位成员：`analyst` 用只读工具查询并起草，`reviewer` 对照证据检查草稿。检查标准是写明订单号、最新状态和时间，不编造预计送达日期。两人按固定顺序轮流发言，最多允许六个**成员回合**。一个回合是某位成员接手并完成一次响应；内部可能有工具事件和模型调用。

1. **查询并起草 v1。** `analyst` 请求 `read_delivery(O42)`。假设应用先核对用户的读取权限，工具再返回：订单在 **2026-09-28 09:20（UTC+8）** 到达分拨中心，`estimatedDelivery` 为 `null`，证据编号 `delivery-O42-0928-0920`。它却写成“订单已到分拨中心，预计今天送达”，还漏掉状态时间。“今天送达”是特意设置的错误：工具没有给这个日期。
2. **检查 v1。** `reviewer` 收到 v1 与工具结果，要求删除无依据的送达承诺，补上状态时间。它返回“需要修改”，并指向 v1 与证据编号。这样下一位知道要改哪一稿、依据是哪次查询。
3. **修订为 v2。** `analyst` 沿用仍适用的证据，写出：“订单 O42 截至 2026 年 9 月 28 日 09:20 已到达分拨中心；系统尚未提供预计送达时间。”本例不必为消耗回合再次查询；真实业务若数据可能过期，应用还需规定重新查询的时机。
4. **检查 v2。** `reviewer` 核对 v2 与证据，给出指向 v2 的“通过检查”结论。应用核对结论来自 `reviewer`、对应最新版本和本任务证据，才把 v2 连同结论交给用户，仍标注**待用户审核**。

这条链中，任务、工具请求、执行结果、草稿和检查意见并非同一种消息。自然语言说“我查过了”不能代替工具返回；说“通过”也不能代替对**当前草稿**的有效检查。AgentChat 的工具教程区分 `ToolCallRequestEvent`、`ToolCallExecutionEvent` 和工具摘要消息，有助于观察请求与实际执行。[AutoGen Agents](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/agents.html)

## AgentChat：谁加入团队，谁接着发言

看过四步，框架接口就有了落点。AgentChat 提供常用 Agent、聊天消息、团队与终止条件。**Team** 是为共同任务协作的一组 Agent；团队运行时将响应放入共享的对话上下文，并按所选模式安排后续发言。[AutoGen AgentChat](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/index.html)、[AutoGen Teams](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/teams.html)

本例顺序固定，可用 `RoundRobinGroupChat` 理解：`analyst → reviewer → analyst → reviewer`。`SelectorGroupChat` 则可用模型选择下一位；其他团队模式还可通过交接消息转移控制。**选发言者解决“下一步谁做”，终止条件解决“现在是否停”。**动态选择带来选择成本与误选机会，固定顺序足够时无须引入它。[AutoGen Teams](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/teams.html)

共享对话上下文不等于共享业务数据库或权限。若 `reviewer` 只收到“请检查这段话”，没有查询结果、时间和证据编号，就无法核对“今天送达”。角色名字也不会自动产生独立证据。官方建议先考虑给单个 Agent 配齐工具与指令，再判断复杂任务是否需要团队。[AutoGen Teams](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/teams.html)

## Core：当团队预设不足时，消息怎样投递

AgentChat 构建在 `autogen-core` 之上。**Core 关注消息与运行时**：Agent 收到消息，运行时调用相应处理函数；函数可以调用模型、工具，也可以只执行普通代码。消息是可序列化的数据，可以携带任务号、草稿版本、证据编号或错误，不能把正在执行的函数塞进消息。Core 可把消息直接发给指定 Agent，也可向主题发布、由订阅者接收。应用仍要定义谁处理什么消息、收到后做什么。[AutoGen Core](https://microsoft.github.io/autogen/stable/user-guide/core-user-guide/index.html)、[Message and Communication](https://microsoft.github.io/autogen/stable/user-guide/core-user-guide/framework/message-and-communication.html)

O42 的轮流起草与检查可由 AgentChat 的团队预设表达，无须先写 Core 主题订阅。若以后要让查询结果同时通知审核和记录组件，或定义自己的消息类型与路由规则，Core 才提供更细控制。**AgentChat 是常用协作形式，Core 是其下层消息机制**；这不是“一个负责思考、一个负责对话”的分工。[AutoGen AgentChat](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/index.html)

## 停下来：通过检查与用完额度是两种结果

没有停止规则，两位成员可能一直互相要求完善；只查文本里是否有 `APPROVE`，又可能在 `analyst` 引用旧意见时误停。AgentChat 的**终止条件**检查新增的消息或事件。对 `RoundRobinGroupChat` 等团队，官方文档说它在每位成员完成响应后调用一次；单个响应里的多个内部消息一起交给条件判断。条件可以组合，内置条件涉及消息数量、文本、token 用量、时间和外部停止等。[AutoGen Termination](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/termination.html)

本例要区分两种结局：有效的 v2 检查结论出现，属于**成功停止**；到六个成员回合仍未通过，属于**限额停止，草稿待处理**。如果工具在某回合内一直等待，回合后的终止检查还没机会运行，工具本身需要超时。成员回合、消息、工具调用、模型调用也是不同计数：第一回合就可能含工具请求、执行事件和面向团队的最终消息。六回合不等于六次模型请求。`TokenUsageTermination` 依赖 Agent 报告用量，缺失报告不能当作零成本。[AutoGen Termination](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/termination.html)

应用最好核对“通过检查”消息的**来源、类型、当前草稿版本与证据关联**，而不是匹配任意消息中的词。这只能防止串稿和明显误停，无法证明 `reviewer` 的语义判断正确。终止条件在一次运行后可重置，Agent 自身却可能保留历史；任务若分段继续，应用还要保存跨次预算与已经发生的外部操作。[AutoGen Termination](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/termination.html)、[AutoGen Agents](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/agents.html)

## 停止后交付什么，怎样检验分工

最后一条消息可能是 `reviewer` 的“通过检查”，用户需要看的却是前一轮的 v2。应用应按任务结构提取**草稿、对应证据、检查结论与停止原因**。到上限时不能把“团队已停止”显示为“草稿已通过”。若以后加入发邮件等写入工具，停止团队不会撤销已发出的邮件；恢复前须核实外部操作结果。[AutoGen Teams](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/teams.html)、[任务状态](#/lesson/agent-state)

是否值得使用两位 Agent，要在任务上比较。可以用同一组假设用例测试“`analyst` + `reviewer`”与“单 Agent + 确定性字段检查”：缺失预计日期、冲突时间、工具失败、引用旧证据。记录草稿是否有依据、错误是否被修正、额外回合与模型调用花了多少、限额停止是否清楚。两位成员也可能共享同一错误或反复改动正确文本；AutoGen 提供组织协作的接口，**不会自动提高正确率**。

<details>
<summary>面试怎么回答</summary>

**一分钟回答：** AutoGen 是构建多 Agent 应用的框架。AgentChat 提供成员、团队、消息与终止条件；其下的 Core 提供事件驱动的消息投递和处理。比如查询者读订单并起草，检查者对照工具证据审稿，团队规则决定谁下一轮发言。成功条件要关联当前草稿与检查结论，回合上限和工具超时防止无限运行。停止后交付草稿、证据及原因；业务权限与正确性仍由应用和验收过程负责。

**追问一：为什么不直接用一个 Agent？** 若只是核对订单号、时间等确定性字段，单 Agent 加代码校验更简单。若检查需要独立工具、不同证据或持续反馈，再比较质量改善能否抵得上额外回合与错误机会。

**追问二：`RoundRobinGroupChat` 与 `SelectorGroupChat` 怎么选？** 前者适合起草、检查这种固定顺序；后者适合下一位取决于当前内容的任务，但要承担选择成本与误选风险。二者都不能替代完成判定。

**追问三：看到 `APPROVE` 就停止有什么问题？** 它可能出现在引用、工具结果或旧稿意见中。应用应核对发出者、消息类型、当前版本与证据关联，并区分有效通过和到达上限。

</details>

**练习：** 第 2 回合 `reviewer` 要求修改 v1。第 3 回合 `analyst` 提交 v2，却引用了旧消息里的 `APPROVE`；团队按关键词停下，界面显示“已完成”。给出两项停止规则修改、一项交付状态修改；如果还有预算，下一步该由谁工作？

<details>
<summary>参考思路</summary>

停止规则要限定结论来自 `reviewer` 的检查消息，并指向**当前 v2** 及本任务证据；出现字符串不算通过。交付状态应写“运行提前停止，v2 尚未获得有效检查结论”。若预算和证据时效允许，保留已用回合与历史，继续把 v2 交给 `reviewer`；不能把恢复当作新任务重新获得全部预算。

</details>
