# AutoGen：对话式协作怎样运行和停止

假设两个 Agent 一起准备订单回复。一个负责查询并起草，另一个负责检查。第一轮发现缺少依据，第二轮提出修改，第三轮改写以后又收到“还可以更完整”的建议。如果没有明确交付条件，它们可以不断互相回复；如果仅凭任何消息里出现“通过”就结束，又可能在引用别人的文字时提前停止。多 Agent 应用除了需要能对话，还需要规定消息怎样到达、谁接着工作，以及什么证据足以结束。

AutoGen 把这些问题放在不同层次处理。本篇以 2026-09-28 实际查阅的 Microsoft AutoGen stable 文档为范围，讨论 autogen-core 与 autogen-agentchat 的架构。stable 是会更新的文档入口，不是一个不可变的包版本；真正运行时仍应锁定兼容版本。这里不用 v0.2 的旧调用方式，也不把两个角色的协作假定为必然优于单个 Agent。是否值得分工，先看 [多 Agent](#/lesson/multi-agent)。

## Core 管消息，AgentChat 管常见协作形式

Core 是事件驱动的底层运行框架。事件驱动（event-driven）表示 Agent 收到消息后，由相应处理函数决定怎么响应，而不是整套系统只能沿一条预先写死的调用栈执行。Agent 运行时（runtime）负责消息投递与处理调度，Agent 自己实现处理逻辑。一个处理函数可以调用模型，也可以只执行普通代码；叫作 Agent 并不要求每收到一条消息都运行一次 LLM。[AutoGen：Core](https://microsoft.github.io/autogen/stable/user-guide/core-user-guide/index.html)

Core 中的消息是可序列化数据。它可以携带任务编号、查询结果或错误，消息本身不应夹带执行逻辑。运行时可以把一条消息直接发给目标 Agent，也可以将消息发布到主题，由订阅者接收。直接请求可以等待处理函数的返回，发布则适合让多个关注该主题的参与者收到事件。消息投递提供通信机制，但谁对任务负责、哪些接收者该响应，仍须由应用定义。[AutoGen：Message and Communication](https://microsoft.github.io/autogen/stable/user-guide/core-user-guide/framework/message-and-communication.html)

AgentChat 建在 Core 之上，提供常用 Agent、团队（team）、聊天消息和终止条件等较高层抽象。想要一个查询者与检查者轮流交流，不必先自行实现主题订阅和所有调度细节；需要自定义事件协议或更细的路由行为时，再使用 Core 的接口。AgentChat 与 Core 是上下层关系，不是两个互相竞争的模型，也不能用“前者对话、后者推理”来区分。[AutoGen：AgentChat](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/index.html)

在团队中，发言者选择（speaker selection）决定下一位由谁响应。RoundRobinGroupChat 按成员顺序轮流运行；SelectorGroupChat 使用模型或自定义选择逻辑来决定下一位；其他团队还可以通过交接消息控制转移。选择发言者解决工作调度，不等于判断任务已经成功。动态选择也可能增加模型调用与错误机会，顺序固定的任务没有必要为了显得灵活而引入额外调度。[AutoGen：Teams](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/teams.html)

## 一份订单回复的四个团队回合

下面用一个假设的小团队走完整次任务。所有订单、工具结果和 Agent 发言都是教学构造，没有调用 AutoGen、模型或订单系统。用户输入：“查询订单 O42 的配送进度，给我一份可以审核的回复草稿。”任务只允许读取订单，不允许更改配送或发送给客户。

团队有两个成员。analyst 可以调用只读配送工具并起草；reviewer 检查草稿是否包含订单号、最新状态及其时间，是否虚构预计送达时间。两者按固定顺序轮流响应，应用设定本次最多 6 个成员回合。交付条件是有证据支持的草稿经过 reviewer 检查，停止时仍标注“待用户审核”，不会把 Agent 的检查替代用户的最终决定。

第 1 回合由 analyst 工作。它请求 read_delivery，参数是 O42，工具调用标识为 c1。应用校验当前用户可读该订单，再执行查询。假设返回如下数据；字段是本例自定义结构，不是 AutoGen 的工具结果协议：


```json
{
  "orderId": "O42",
  "status": "到达分拨中心",
  "observedAt": "2026-09-28T09:20:00+08:00",
  "estimatedDelivery": null,
  "evidenceId": "delivery-O42-0928-0920"
}

```

这次成员回合内部至少要区分工具请求、工具执行结果和向团队发出的最终消息。AutoGen AgentChat 的官方示例分别展示 ToolCallRequestEvent、ToolCallExecutionEvent，以及工具摘要消息。请求事件表示模型提出了什么，执行事件保存程序取得的结果；“我查询了订单”这句自然语言不能代替执行证据。[AutoGen：Agents 的工具事件示例](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/agents.html)

为展示检查的作用，假设 analyst 的草稿 v1 错写成：“订单已到分拨中心，预计今天送达。”它还遗漏了状态时间。这是一个明确的教学错误：工具的 estimatedDelivery 为空，不能支持“今天送达”。团队收到的发言应携带草稿编号、版本和 evidenceId，使下一位能核对同一份内容。框架可以广播消息，但不会自动替应用补上这些业务关联。

第 2 回合轮到 reviewer。它检查 v1 与引用的工具结果，指出两个问题：删除无依据的送达日期，补上 9 月 28 日 09:20 的查询状态时间。它返回“需要修改”，同时引用 draft-v1 与 evidenceId。检查意见只针对当前草稿，不要用“看起来不错”一类笼统认可覆盖未查证字段。

第 3 回合回到 analyst。已有证据足够完成修订，不需要为了消耗回合再次查询。它生成 v2：“订单 O42 截至 9 月 28 日 09:20 已到达分拨中心；系统尚未提供预计送达时间。”第 4 回合 reviewer 核对 v2，返回通过检查的结构化结论。应用确认回复确实来自 reviewer、对应最新的 v2，而且引用的证据属于本任务，再结束运行，交付 v2 和检查结论。

| 团队回合 | 当前成员 | 新增内容 | 后续动作 |
| --- | --- | --- | --- |
| 1 | analyst | 查询证据与存在错误的 v1 | 交给 reviewer |
| 2 | reviewer | v1 缺少时间、虚构送达日 | 交给 analyst 修订 |
| 3 | analyst | 删除虚构信息的 v2 | 再交 reviewer |
| 4 | reviewer | 对 v2 的检查结论 | 应用核验后停止 |

RoundRobinGroupChat 让成员按顺序发言，并共享团队对话上下文。这使 reviewer 能收到前面的材料，但共享消息不等于所有成员拥有同一份业务数据库，也不保证它们对文字作出相同理解。检查者若只看到压缩后的草稿而看不到证据，就无法核实预计日期；给它一个角色名称不会解决输入缺口。

## 停止条件要区分业务完成与资源耗尽

终止条件（termination condition）负责判断一次运行何时结束。AutoGen 提供按消息数量、文本出现、token 使用、时间、交接或外部信号等停止的方法，也允许组合条件。官方文档说明，团队通常在一个成员完成响应后检查终止条件；这次响应内部即使产生多个事件，也是把新增序列交给条件判断。[AutoGen：Termination](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/termination.html)

因此，回合数、消息数、工具次数与模型调用次数不能混用。本例完成了 4 个成员回合；若每回合各产生一条最终聊天消息，加上用户任务，就是 5 条聊天消息。第 1 回合还包含一条工具请求事件和一条执行事件，事件流中就有更多对象。成员也可能在一次响应里调用不止一次模型。设定“最多 6 回合”，不能推断费用只对应 6 次模型请求。

本例的成功条件与上限条件应该是“或”的关系：最新草稿获得有效检查结论时停止；达到 6 回合还未通过时也停止，但返回“预算耗尽，草稿仍需处理”。4 回合已经通过，就不必把剩余 2 回合用完。若把完成与预算写成必须同时成立，就会让已经完成的任务继续工作，或让没有完成的任务无法依靠预算退出。

“消息含 APPROVE 就停”适合演示，却需要应用约束。analyst 可能引用 reviewer 上一轮的文字，工具结果也可能包含相同字符串。更清楚的判定要检查消息来源、类型、草稿版本与状态；字符串从哪来，是它含义的一部分。本例核验这些字段，仍不能证明 reviewer 的语义判断永远正确，只有基本的运行关联得到了保证。高要求任务仍需外部校验或人的审核。

上限还应覆盖单个回合内部的开销。若某个工具一直等待，团队还没等到成员返回，回合后的终止检查不能代替该工具的超时。模型 token 上限、工具调用预算、请求超时及用户停止，应在对应边界发挥作用。AutoGen 的 TokenUsageTermination 依赖消息提供用量，没报告用量时不能把它当成可靠的总费用计数器。[AutoGen：Termination 的调用时机与用量条件](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/termination.html)

## 运行结束以后，还留下哪些状态

团队运行返回结果与停止原因，应用应一起保存。只有“最后一条消息”可能恰好是 reviewer 的一句检查结论，真正要给用户的草稿在前一条；因此交付对象应根据任务结构提取，而不是机械展示列表末尾。成员状态、草稿版本、证据引用和预算使用也有助于解释为什么停在这里。

AgentChat 的 Agent 是有状态的，官方教程要求后续调用传入新增消息，而不是每次再塞一次完整历史。终止条件在一次运行结束后可以重置，这不等于 Agent 历史或业务状态也被清空；应用若限制一项跨多次运行的总预算，还要自己持续累计，不能每次恢复都免费获得一整份额度。[AutoGen：Agents](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/agents.html)、[Termination](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/termination.html)

恢复与撤销仍是不同问题。本例只有读取，若以后加入发送邮件等工具，停止团队不会收回已发出的邮件，恢复旧状态也不能证明外部动作尚未发生。沿用 [任务状态](#/lesson/agent-state) 中的原则，必须保留可核实的操作结果。Core 的异步消息也不等于自动获得跨系统事务或恰好一次业务执行保证。

这些机制让协作过程可以观察和控制，却不能让沟通天然有效。analyst 和 reviewer 可能共享同一种错误，reviewer 也可能提出不必要的修改。评估时可以给它们缺失预计日期、冲突时间、工具失败和错误草稿，再与一个 Agent 加确定性字段检查的方案比较。看最终草稿是否有依据、是否在预算内完成，以及额外回合是否真正修正错误，比只看“两个 Agent 讨论了很久”更有意义。

<details>
<summary>面试怎么回答</summary>

**一分钟回答：** AutoGen Core 提供事件驱动运行时和消息通信，Agent 根据收到的数据执行处理逻辑；AgentChat 在它上面提供常用 Agent、团队、发言者选择和终止条件。以查询者和检查者为例，团队决定谁下一轮工作，工具事件保留外部查询证据，检查结果关联具体草稿版本。运行既要有完成条件，也要有回合、调用或时间上限，并区分成功停止与预算停止。框架组织消息和调度，不保证成员意见正确，也不替应用定义业务成功。

**追问一：6 个回合为什么不等于 6 条消息或 6 次模型调用？** 一个成员响应内部可能产生工具请求、执行结果和最终消息，还可能调用多次模型。用户任务是否计数、内部事件是否计数，要查具体预算类型。分别定义团队回合与模型、工具预算，才能知道上限控制了哪一部分。

**追问二：用 reviewer 输出 APPROVE 作为终止条件有什么问题？** 相同字符串可能出现在引用或其他成员的消息里，也可能针对旧草稿。应绑定来源、消息类型、当前版本和检查对象，再做必要的证据校验。即使来源正确，reviewer 也可能判断错，结构化通过只是可审计的判断，不是事实正确的自动证明。

</details>

练习：第 2 回合 reviewer 要求修改 v1；第 3 回合 analyst 提交 v2，但复制了一句“reviewer 上次说 APPROVE”。团队因此停止。同时，界面只显示“已完成”。指出至少三处应修正的设计，并写出这次停止状态应该怎样描述。

<details>
<summary>参考思路</summary>

停止检查不应匹配任意消息中的字符串，应限定 reviewer 的有效检查结论；结论必须指向当前 v2，不能复用旧版本；界面应区分循环已停止与草稿通过检查。当前只能说“运行提前停止，v2 尚未获得有效检查结论”。如果预算仍允许，可从保留状态继续交给 reviewer；继续前保留已使用回合，不能重置成一项全新任务。修复这些规则后，还应测试工具结果和引用文字也包含 APPROVE 的情况。

</details>
