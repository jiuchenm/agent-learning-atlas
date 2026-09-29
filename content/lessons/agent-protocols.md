# ACP、A2A、MCP：一次 Agent 任务到底经过了哪几层协议

假设你在 IDE 里问编码助手：“退款金额算错了。先查业务规则和相关代码，给我定位与修复建议，暂时别改文件。”编辑器显示助手正在读代码。过了一会儿，它又显示“向规则助手查询退款口径”，随后查到一份规则文档，最后给出建议。你可能会问：编辑器怎么知道助手做到哪一步？“规则助手”与“查文档的工具”有什么差别？这些调用是不是都可以用一个叫 Agent 协议的东西包起来？

这正好是三个协议容易被说成一回事的地方。本文里的 ACP 指 **Agent Client Protocol**，也就是编辑器等客户端与编码 Agent 通信的协议。A2A 是 **Agent2Agent Protocol**，用于一个 Agent 系统向另一个 Agent 系统发消息、跟踪任务。MCP 是 **Model Context Protocol**，用于 Agent 应用连接工具、资源等外部能力。缩写 ACP 在别的项目里也可能另有所指；这里限定为 [Agent Client Protocol 官方介绍](https://agentclientprotocol.com/get-started/introduction)。

下文的退款系统、规则助手、文档服务和具体结果全是假设的。它们用于观察消息怎样流转，不代表腾讯或任何公司的内部架构。你可以先读 [MCP](#/lesson/mcp)、[多 Agent](#/lesson/multi-agent) 和 [任务状态](#/lesson/agent-state)，但这里也会把需要用到的概念说明白。

## 第一跳：IDE 怎样把你的话交给编码 Agent

用户点“发送”时，直接接收输入的是 IDE。假设 IDE 通过 ACP 连接一个独立运行的编码 Agent。协议把 IDE 叫 **Client**，把负责工作、可能调用模型和工具的程序叫 **Agent**。这和 MCP 里的 Client 不是同一个角色；“Client”只表示当前这条连接的发起或使用方，脱离协议上下文就容易误会。

按 [ACP v2 的流程说明](https://agentclientprotocol.com/protocol/v2/overview)，双方先用 `initialize` 确认版本与能力，再用 `session/new` 建立会话。会话有 `sessionId`，承载这次交互的上下文。IDE 发 `session/prompt`，内容是你的退款问题。Agent 接受这条用户消息后，返回对应的 `messageId`；后面的工作进度、输出和结束状态，通过 `session/update` 通知陆续送回 IDE。[官方 Prompt Lifecycle](https://agentclientprotocol.com/protocol/v2/prompt-lifecycle) 特别区分了“消息已接收”和“工作已完成”：`session/prompt` 的响应不等于修复建议已经生成。

这个区别在真实界面上很有用。假设 IDE 已拿到 `messageId`，屏幕出现你的提问，但 Agent 还在读文件；此时若把消息响应当作任务结束，界面会提前显示“完成”。Agent 可以继续发送 `agent_message_chunk`、`tool_call_update` 或 `state_update`。你看到的“正在读代码”通常是 Agent 向 Client 报告的一项工具活动，而非 IDE 自己猜出来的模型内部状态。最终报告 `idle` 才表示本轮前台工作停下；它也不自动证明每个业务结论都正确。

本地运行时，ACP 官方介绍说 Agent 可以是 IDE 启动的子进程，经 stdio 传 JSON-RPC；远程场景可使用 HTTP 或 WebSocket，但官方目前仍把**完整远程支持**标成进行中的工作。[官方介绍](https://agentclientprotocol.com/get-started/introduction) 因此，不能从“支持 ACP”四个字推断任一编辑器已能稳定连接任意云端 Agent。本文依据的是 2026-09-29 读取的 ACP v2 文档；ACP v1 也仍在文档目录中，方法和完成语义应按双方实际协商的版本核对。

还有一个权限问题。你的要求是“先别改文件”。IDE 能通过 ACP 显示 Agent 提出的操作，也可承接 Agent 向用户提出的权限请求；但协议不会凭一句自然语言自动替所有实现强制执行只读。应用需要把会话模式、权限选择和本地执行策略对应起来。官方 [Tool Calls 文档](https://agentclientprotocol.com/protocol/v2/tool-calls) 也把 `tool_call_update` 定义为 Agent **报告**工具执行情况；报告里有工具名，并不等于工具已获得授权，更不等于 IDE 亲自执行了它。

## 第二跳：编码 Agent 为什么要找另一个 Agent

编码 Agent 能看代码，却未必持有最新的退款规则，也可能被限制不能直接读取业务知识库。假设另一个“规则助手”负责回答规则问题，并可独立查资料、澄清问题、产出带出处的结论。编码 Agent 向它委托：“查退款金额的当前计算口径；只提供解释和来源，不改代码。”这时对话的两端都是有自己执行过程的 Agent 系统。A2A 正是为这种边界设计的。[A2A 1.0.0 规范](https://a2a-protocol.org/latest/specification/) 把发起方称为 A2A Client，把远端执行方称为 A2A Server；“Server”在这里仍是 Agent 系统，不是数据库工具。

编码 Agent 先了解远端能做什么。A2A 的 **Agent Card** 是远端发布的能力说明，包含身份、技能、服务入口及认证要求。它帮助发起方选择合适的 Agent，但看见“会处理退款规则”并不能证明当前身份有权查询某份文档。假设发起方已选择规则助手并获得相应凭据，它发出一条 **Message**，里面有具体问题和必要上下文。远端可以直接回一条 Message，也可以创建一个带唯一 ID 的 **Task**。Task 是可跟踪的工作单元；相关任务还可由 `contextId` 关联。最后的报告或结构化结果可作为 **Artifact** 返回。这里的 Task 不是 IDE 的 ACP 会话，也不是模型某一轮生成。

我们的假设里，规则助手需要一段时间查询来源，于是返回 Task `T-27`，状态仍在处理中。编码 Agent 把“规则查询进行中”映射回 ACP 的 `session/update`，IDE 才能让你看到进度。稍后规则助手可能把 Task 更新为需要补充输入，例如“你问的是全额退款还是部分退款？”编码 Agent 需要把这个问题带回用户，再把答案发给对应的远端任务。不能看到一个 `T-27` 就假定它已经完成，更不能把状态更新当成最终来源。[A2A 规范的 Send Message、Get Task 与状态定义](https://a2a-protocol.org/latest/specification/) 允许客户端继续获取任务状态及产物；长任务也可以选择流式更新或推送通知，取决于服务端能力和双方使用的绑定。

这意味着 A2A 的“流式”也有自己的对象：任务状态变化、产物片段等。ACP 的流式更新则面向 IDE 如何展示编码 Agent 的消息、工具活动和工作状态。编码 Agent 可以把 A2A 进度转述给 IDE，但两条流之间没有天然的一对一映射；它必须决定哪些远端事件要显示，哪些需要合并或过滤。规则助手若返回“查询中”，编码 Agent 不应对用户显示“规则已核实”。

A2A 最新页面在本次核验时标为 **1.0.0**，规范把数据模型、抽象操作和传输绑定分层，列有 JSON-RPC、gRPC、HTTP/REST 等绑定。因此“走 A2A”不足以确定每个部署都发同样的 HTTP JSON 消息。讲具体方法名、字段或 SSE 行为时，要同时说明版本与绑定；这里故意只画语义步骤。[A2A 规范的版本与分层说明](https://a2a-protocol.org/latest/specification/)

## 第三跳：规则助手怎样查到文档

规则助手要回答“当前口径”，仍须接入真实资料。假设它连接一台知识库 MCP Server。它内部的 MCP Client 与 Server 初始化，发现 `search_policy` 工具，然后调用它查询退款规则；Server 再访问受控文档系统并返回相关段落和出处。规则助手核对内容后，才把结果作为 A2A Task 的产物送回编码 Agent。原有 [MCP 课程](#/lesson/mcp) 已按固定的 **2025-06-18** 版本解释 `initialize`、`tools/list` 和 `tools/call`；官方 [MCP 架构](https://modelcontextprotocol.io/specification/2025-06-18/architecture) 说明了 Host、Client、Server 的关系，[工具规范](https://modelcontextprotocol.io/specification/2025-06-18/server/tools) 则给出发现与调用的协议结构。

这里有个看似小、却决定排障方向的差别：A2A 的规则助手接下的是“请查清规则并解释”的任务；MCP 的 `search_policy` 暴露的是“按给定参数查资料”的能力。MCP Server 可以很复杂，但 `tools/call` 本身并不承诺替调用方规划任务、追问用户、持续维护 A2A Task。反过来，A2A 远端也可以不用 MCP，直接调用自有 API；用哪种方式获取资料是它的内部实现。

把整条链写在纸上，就能看到谁在做什么：

```text
用户 ──输入问题──> IDE
IDE ──ACP 会话与 prompt──> 编码 Agent
编码 Agent ──A2A Message / Task──> 规则助手
规则助手 ──MCP tools/list、tools/call──> 知识库 MCP Server ──> 文档系统
                 资料与出处 <─────────────────────────────────────┘
编码 Agent <──A2A 状态和 Artifact── 规则助手
IDE <──ACP session/update── 编码 Agent ──> 用户看到建议
```

假设文档系统返回：“在规则版本 R5 中，部分退款的上限按实付金额计算”，同时给出文档链接。规则助手的回答应带上“R5、部分退款、实付金额”这些限定。编码 Agent 再检查代码里是否把标价当成上限，并向你提出“可能的错误点、对应代码位置和建议修改”，仍不改文件。要是远端只返回一段没有版本和出处的文字，编码 Agent 应继续核验或标明不确定，不能因为它来自另一个 Agent 就提高可信度。

## 三条边界都要重新看权限

这条链跨过了至少三道权限边界。IDE 和编码 Agent 的边界决定能读哪些本地文件、哪些动作需要用户确认；编码 Agent 与规则助手的边界决定允许发出哪些业务信息、对方能否访问指定资料；规则助手与 MCP Server、文档后端的边界决定工具调用者实际能查到什么。一次“登录成功”或 Agent Card 宣称某项技能，都不等于每一层已经授权。

例如，你给编码 Agent 发了含内部订单号的问题，编码 Agent 不能仅因为 A2A 支持委托就把整个本地对话及工作目录交给远端。它应只发送完成规则查询所需的信息。A2A 规范要求服务端认证请求，并在 Task 可见性上做授权范围限制；Agent Card 说明认证方案，但凭据取得、业务权限判断另有职责。[A2A 规范的认证与授权部分](https://a2a-protocol.org/latest/specification/) MCP 也强调 Host 对数据共享和工具调用的用户控制，具体访问限制还须由 Server 与后端实施。[MCP 2025-06-18 规范](https://modelcontextprotocol.io/specification/2025-06-18)

如果规则助手随后要求写回一条退款配置，授权需要重新判断。用户只授权“查清并建议”，没有授权远端修改。A2A 状态中的“等待授权”本身也不能充当操作许可；规范明确区分需要授权的状态和授权决定的范围。编码 Agent 应先停在边界处，向用户说明要改什么、由谁改，再按适用策略处理。协议负责传达状态与请求，不能替人决定“这次写入是否应该发生”。

遇到故障时，按跳排查比笼统说“Agent 协议坏了”有效：IDE 没收到进度，先看 ACP 的会话与通知；规则查询迟迟不结束，看 A2A Task 状态、是否等待输入或认证；远端已接任务却查不到资料，看 MCP 工具发现、调用结果及文档后端权限。每一层都可能返回“请求被接收”，却还没有拿到最终事实。

<details>
<summary>面试怎么回答</summary>

**一分钟回答：ACP、A2A、MCP 分别解决什么？** 在编码场景里，ACP 规范编辑器等 Client 与编码 Agent 的会话、用户消息、进度和权限交互。A2A 规范一个 Agent 系统向另一个 Agent 系统发现能力、发送消息、跟踪长任务和收取结果。MCP 规范 Host/Client 与工具或资源 Server 的连接、发现和调用。比如 IDE 经 ACP 把问题交给编码 Agent，它经 A2A 委托规则助手，规则助手再经 MCP 查资料。三者可以组合，但 Agent 也可以直接用 API，不要求每个系统同时采用三者。实现细节应按版本和实际授权边界核对。

**追问一：ACP 里报告了 `tool_call_update`，是否代表 MCP 调用成功？** 不是。ACP 这条通知面向 IDE 展示 Agent 报告的工具活动。工具可能是本地函数、终端命令或 MCP 工具；报告“开始执行”与拿到成功结果是两个时刻，还要看后续状态和实际工具返回。工具名本身也不授予权限。

**追问二：A2A 的 Agent Card 写了某项技能，能直接把全部用户上下文发过去吗？** 不能。Card 帮助发现能力和认证要求，不等于当前请求已经获准。调用方仍应验证远端身份与权限，只发送完成任务需要的上下文；远端也应按调用者身份限制 Task 和数据可见范围。

**追问三：为什么 A2A 的 Task ID 不能直接当 ACP Session ID？** 两者标识的对象不同。ACP Session 是编辑器和编码 Agent 的交互上下文；A2A Task 是远端 Agent 管理的一项具体工作。一个会话可发起多个远端任务，一个远端任务也可能需要补充消息。应用可以保存两者的关联，但不能把 ID 的生命周期、状态与权限直接混用。

</details>

练习：仍以上面的假设任务为例。IDE 已收到 ACP `session/prompt` 的接受响应；A2A 规则助手返回 Task `T-27`，状态为等待补充输入；MCP 搜索工具尚未返回结果。此时 IDE 可以向用户显示什么？如果编码 Agent 发现远端请求上传整个本地项目，应该在哪条边界停下？

<details>
<summary>参考思路</summary>

IDE 可以显示“问题已送达编码 Agent，规则查询等待补充输入”，并展示远端具体想澄清什么。它不能显示“任务完成”或编造退款规则，因为 ACP 的接受响应只确认消息进入会话，A2A Task 还未结束，MCP 资料也未取得。编码 Agent 在向 A2A 远端发送项目内容前就该停下：先判断整个项目是否必要、是否符合用户授权和数据共享策略，再请求所需的具体许可。即使获准分享少量文件，远端访问 MCP 文档系统仍由它自己的身份和后端权限约束。

</details>
