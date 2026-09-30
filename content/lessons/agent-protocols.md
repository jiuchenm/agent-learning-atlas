# ACP、A2A、MCP：一次任务经过哪几层协议

你在 IDE 里问编码助手：“退款金额算错了。先查业务规则和相关代码，给我定位与修复建议，暂时别改文件。”界面先显示“正在读代码”，随后显示“向规则助手查询退款口径”，最后给出建议。这里至少有三个问题：IDE 怎样收到进度？规则助手怎样接住一项需要继续追问的任务？它又怎样查到规则文档？

**协议（protocol）**是通信双方共同遵守的约定：消息按什么格式发送，字段是什么意思，如何关联请求与结果，状态变化怎样解释。**ACP、A2A、MCP 分别覆盖不同的通信边界**，可以出现在同一次任务里。协议规定双方怎样交互；框架提供组织程序和运行任务的代码。实现可以采用某个框架，也可以自行编写，不能把这三个协议当成互斥产品。[ACP 介绍](https://agentclientprotocol.com/get-started/introduction)、[A2A 1.0.0 规范](https://a2a-protocol.org/v1.0.0/specification/)、[MCP 架构](https://modelcontextprotocol.io/specification/2025-06-18/architecture)分别给出了各自的角色与边界。

## 三层通信分别连接谁

本文的 ACP 专指 **Agent Client Protocol**，用于编辑器等客户端与编码 Agent 通信。A2A 是 **Agent2Agent Protocol**，用于独立 Agent 系统之间交换消息、委托和跟踪任务。MCP 是 **Model Context Protocol**，用于 Agent 应用接入工具、资源等外部能力。ACP 这一缩写在其他项目中也可能有别的展开，查资料时要核对全名。

把退款排查中的参与者放在对应边界上，就能看出区别：

| 协议 | 本例的两端 | 需要跟踪的对象 |
| --- | --- | --- |
| ACP | IDE ↔ 编码 Agent | 会话、用户消息、前台工作与工具活动 |
| A2A | 编码 Agent ↔ 规则助手 | 委托消息、远端任务、任务产物 |
| MCP | 规则助手内的 Client ↔ 文档 Server | 能力发现、具体工具请求与返回 |

下面整条链都是**教学假设**，不代表腾讯或 Microsoft 的实际架构。假设当前规则版本 R5 规定：部分退款不得超过实付金额；订单标价 100 元、实付 80 元，用户申请退款 90 元。代码误用标价作上限，算出 90 元；按本例规则，上限应为 80 元。编码 Agent 需要找出这个差异，并给出建议。

本篇固定使用 **ACP v2 文档、A2A 1.0.0、MCP 2025-06-18**，关键片段核验日期为 2026-10-01。ACP v2 是文档路径的版本标签，本文未取得不可变发布 SHA；不要据此推断具体 IDE 支持 v2。A2A 使用固定版本入口，MCP 沿用本站课程版本，不称为最新版。先修可回看 [MCP](#/lesson/mcp)、[多 Agent](#/lesson/multi-agent)与[任务状态](#/lesson/agent-state)。

## 第一跳：ACP 把用户输入和工作进度接回 IDE

在这条连接中，IDE 是 **Client（客户端）**，编码助手程序是 **Agent**。本地 Agent 可以作为 IDE 启动的子进程，通过 stdio，也就是标准输入输出，交换 JSON-RPC 消息。JSON-RPC 用结构化消息表达方法调用、响应和通知；通知不要求对方逐条返回响应。官方介绍也提到远程 HTTP 或 WebSocket 场景，但仍标注完整远程支持在推进中，所以不能由“支持 ACP”推断任意云端 Agent 都可接入。[ACP 官方介绍](https://agentclientprotocol.com/get-started/introduction)

双方先用 `initialize` 协商版本和能力，再用 `session/new` 创建会话，拿到 `sessionId`。**会话是连续交互的上下文**：这次排查和你随后说“再看一下边界条件”，可以发生在同一会话里。IDE 将退款问题放入 `session/prompt`。按本篇的 v2 文档，Agent 把用户消息插入会话后，响应返回 `messageId`。这只确认消息已接受，读代码和生成建议还在后面。[ACP v2 Overview](https://agentclientprotocol.com/protocol/v2/overview)、[Session Setup](https://agentclientprotocol.com/protocol/v2/session-setup)、[Prompt Lifecycle](https://agentclientprotocol.com/protocol/v2/prompt-lifecycle)

Agent 用 `session/update` 通知持续报告工作。例如 `agent_message_chunk` 是回答的一段内容，`tool_call_update` 是某项工具活动的创建或更新，`state_update` 是前台工作状态的变化。此处的**流式更新（streaming）**意味着内容或事件分批到达，IDE 可以边收边显示，不必等整轮结束。它不意味着每一片都已构成完整答案。[ACP v2 Prompt Lifecycle](https://agentclientprotocol.com/protocol/v2/prompt-lifecycle)

本例中，Agent 开始读代码时报告 `running`；需要用户选择退款类型时可报告 `requires_action`；交付建议、结束前台工作后报告 `idle`。`idle` 表示准备接收新 prompt，后台活动仍可能继续发通知。IDE 还应结合输出与停止原因判断本轮是正常结束还是取消，不能只凭 `idle` 显示“退款问题已解决”。[ACP v2 的状态与取消定义](https://agentclientprotocol.com/protocol/v2/prompt-lifecycle)

工具活动也要读清语义。`tool_call_update` 中的 `toolCallId` 标识会话内的一项工具调用，`status` 报告其进度；它可能对应本地读文件、终端操作或 MCP 调用。IDE 看到“正在搜索规则”只是收到了 Agent 的报告，仍须等实际工具结果。工具名不会赋予权限；必要时 Agent 可通过 `session/request_permission` 请求许可，具体执行限制由应用落实。[ACP v2 Tool Calls](https://agentclientprotocol.com/protocol/v2/tool-calls)

## 第二跳：A2A 把规则查询交给独立 Agent

假设编码 Agent 能读项目，却不能直接访问最新规则库。规则助手拥有自己的检索过程，也能追问“全额退款还是部分退款”。这时编码 Agent 委托的是一项**由对方管理执行过程的工作**。如果需求只是调用固定函数查询一条记录，普通 API 或 MCP 工具也可能足够；不必为了出现两个 Agent 就增加一层协议。

采用 A2A 时，编码 Agent 是 A2A Client，规则助手是 A2A Server。调用方可先读取 **Agent Card（Agent 能力卡片）**，了解服务接口、技能、可选能力和认证要求。Card 中“支持规则查询”是对方声明的能力，尚未证明这次请求能访问目标文档。[A2A 1.0.0 的 Agent Card 与安全定义](https://a2a-protocol.org/v1.0.0/specification/)

编码 Agent 发送 **Message（消息）**：“查询退款上限，给出当前版本和出处。”Message 是一次通信内容；**Task（任务）**是服务端管理的一项工作；**Artifact（产物）**是任务交付的结果。A2A 允许直接返回 Message，也允许返回需要继续跟踪的 Task。本例选择后者，拿到 Task `T-27`，其 `id` 标识任务，`status.state` 表示当前状态。它与 ACP `sessionId` 指向不同对象，应由应用保存关联。[A2A 1.0.0 的 Send Message 与数据模型](https://a2a-protocol.org/v1.0.0/specification/)

假设规则助手起初没收到退款类型，Task 进入 `TASK_STATE_INPUT_REQUIRED`。编码 Agent 将澄清问题经 ACP 带回 IDE；用户答“部分退款”后，它再发送带有 `taskId` 的 Message，续接 `T-27`。规则助手继续工作，状态可变为 `TASK_STATE_WORKING`，最终交付含规则版本与出处的 Artifact，并进入 `TASK_STATE_COMPLETED`。**等待输入是一种中断状态，成功完成才是相应的终态**；拿到 Task ID 远不等于拿到结论。[A2A 1.0.0 的 Message 与 TaskState](https://a2a-protocol.org/v1.0.0/specification/)

调用方可以用 Get Task 获取当前状态；若服务支持流式操作，也可接收任务状态事件 `TaskStatusUpdateEvent` 和产物更新事件 `TaskArtifactUpdateEvent`。A2A 还定义推送通知等方式。编码 Agent 再选择哪些进度转述为 ACP 更新，两个流没有天然的一对一映射。例如远端说“查到两个候选文档”，IDE 应显示查询进度，不能提前显示“规则已核实”。A2A 1.0.0 把数据模型、抽象操作和 JSON-RPC、gRPC、HTTP/REST 绑定分开；具体方法名、字段写法与流式传输方式还要核对所用绑定。[A2A 1.0.0 的操作与绑定](https://a2a-protocol.org/v1.0.0/specification/)

## 第三跳：MCP 把规则查询落实为工具调用

规则助手还需要真实资料。它所在应用充当 MCP **Host（宿主）**，内部的 **Client** 与文档 **Server（服务端）**通信。这些角色描述的是这条连接，不能把 MCP Client 与第一跳的 IDE Client 混为同一个程序。规则助手也可以直接调用自有 API；接入 MCP 是本例选定的实现方式。[MCP 2025-06-18 架构](https://modelcontextprotocol.io/specification/2025-06-18/architecture)

Client 与 Server 先用 `initialize` 确认协议版本、协商能力，完成初始化后，再用 `tools/list` 发现工具。假设 Server 暴露 `search_policy`，其 `inputSchema` 说明参数格式。Client 用 `tools/call` 传入工具 `name` 与 `arguments`；Server 查询文档系统，返回 `content`，若工具执行报错，可以通过 `isError` 表达。[MCP 生命周期](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle)、[Tools 规范](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)

`search_policy`、R5 和本例的金额都属于教学假设。假设此次返回了 R5 的部分退款条款及文档链接，规则助手核对后形成 A2A Artifact。编码 Agent 再对照代码，发现上限使用了标价。最终 IDE 展示：“本例申请 90 元，实付 80 元，按 R5 应限定为 80 元；当前代码得出 90 元，建议检查上限变量。”这才走完输入、资料查询、代码对照和建议交付，文件仍未修改。

可把整个例子的消息方向记为：

```text
IDE ──ACP prompt──> 编码 Agent ──A2A Message / Task──> 规则助手
规则助手内的 Client ──MCP tools/call──> 文档 Server ──> 文档系统
IDE <──ACP update── 编码 Agent <──A2A Artifact── 规则助手 <──工具结果
```

MCP 工具成功返回，仍需核对文档是否适用、版本是否当前、代码是否真的走到该分支。`tools/call` 没有替调用方管理 A2A Task 的承诺；A2A Artifact 也不会自动成为可靠证据。若只有无版本、无出处的一段文字，最终建议必须保留这个缺口。协议增加互操作性，同时也增加版本协商、状态关联和故障处理成本。

## 取消与鉴权：沿三条边界逐层处理

假设规则查询期间你按下“停止”。IDE 可发送 ACP `session/cancel`，Agent 应尽快停止相关模型与工具调用，完成中止并发出剩余更新后，以带 `cancelled` 停止原因的 `idle` 更新收尾。已发出的 A2A Task 还需要编码 Agent 请求 Cancel Task；规范明确说取消成功没有保证，应查看返回的任务状态。规则助手若还在等 MCP 请求，也可对该请求发送 `notifications/cancelled`，其中 `requestId` 指向待取消请求；接收方在请求已结束或无法取消时可以忽略它。[ACP v2 取消](https://agentclientprotocol.com/protocol/v2/prompt-lifecycle)、[A2A 1.0.0 Cancel Task](https://a2a-protocol.org/v1.0.0/specification/)、[MCP 取消](https://modelcontextprotocol.io/specification/2025-06-18/basic/utilities/cancellation)

因此，应用需要关联会话、远端 Task 和工具请求，分别记录“已请求停止”与“已确认停止”。取消也不承诺回滚已发生的业务副作用。本例只有查询；若另一个任务已经修改数据，撤销或补偿要由业务系统另行设计。

**认证（authentication）确认调用者身份，授权（authorization）决定允许它做什么。** ACP v2 的 `authMethods` 描述 Agent 提供的登录方式；适用的方法可经 `auth/login` 登录。A2A 的 Agent Card 可声明安全方案，服务端还须限制任务与数据的可见范围。MCP 2025-06-18 的授权规范针对 HTTP 传输，授权能力是可选的；stdio 按该版本应从环境获取凭据，不应直接套用 HTTP 授权流程。[ACP v2 Authentication](https://agentclientprotocol.com/protocol/v2/authentication)、[A2A 安全定义](https://a2a-protocol.org/v1.0.0/specification/)、[MCP Authorization](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)

一次登录不会自动打通三层权限。编码 Agent 向规则助手发送订单信息前，应只选择查询所需且允许分享的内容；远端调用文档工具时仍受 Server 与后端权限约束。若远端要求上传整个项目或写回退款配置，已经超出本例“查清并建议”的授权范围。即使 A2A Task 进入 `TASK_STATE_AUTH_REQUIRED`，状态本身也不授予任何操作权限，授权范围由实现、凭据发行方或扩展定义。[A2A 1.0.0 In-Task Authorization Scope](https://a2a-protocol.org/v1.0.0/specification/)

排障也沿同样的边界：IDE 不显示进度，查 ACP 会话与更新；规则查询不结束，查 A2A Task 是否等待输入或授权；任务已接收但没有文档，查 MCP 能力发现、工具返回与后端权限。具体产品采用哪个版本、是否支持流式与取消、如何限制读写，本篇没有实测，仍需核验其实现。

<details>
<summary>面试怎么回答</summary>

**约一分钟回答：ACP、A2A、MCP 分别解决什么？** 协议约定通信格式、对象和状态语义。本文的 ACP 是 Agent Client Protocol，连接 IDE 等 Client 与编码 Agent，管理会话、用户输入和进度展示；A2A 连接独立 Agent 系统，用消息、Task 和 Artifact 表达委托、状态与结果；MCP 连接应用内 Client 与工具或资源 Server，负责能力发现和调用。退款排查可以先经 ACP 送入编码 Agent，再经 A2A 找规则助手，最后经 MCP 查文档。三者可以组合，框架负责具体程序组织。实现时要分别协商版本、关联状态和检查权限；消息被接受不等于完成，取消请求也不等于动作已撤销。

**追问一：ACP `tool_call_update` 能证明 MCP 调用成功吗？** 它报告 Agent 的工具活动，工具也可能是本地函数或终端命令。要结合后续状态和实际返回判断是否成功；成功返回之后，仍要验证资料适用范围。

**追问二：A2A Task ID 能直接当 ACP Session ID 吗？** 两者指向不同对象。一个 ACP 会话可以发起多项远端任务；A2A Task 也可能接收多轮补充消息。应用保存对应关系，并分别判断生命周期和访问权限。

**追问三：用户按停止，为什么不能立即显示“所有任务已取消”？** 三层都有各自的取消对象。远端可能已经完成、无法取消或尚未收到请求。先显示停止请求已发出，再依据各层确认更新状态；已经发生的写入还需要业务补偿。

</details>

## 练习：进度、结果与停止分别怎样显示

沿用本例：ACP 已返回 `messageId`；A2A Task `T-27` 进入 `TASK_STATE_INPUT_REQUIRED`，正在问退款类型；MCP 搜索请求 `42` 尚未返回。用户这时点击停止，远端又提出“请上传整个本地项目”。写出 IDE 当前可显示的一句状态，并说明编码 Agent 应保存哪些关联、在哪个位置阻止上传、还要等待哪些停止证据。

<details>
<summary>参考思路</summary>

可以显示“问题已接收，规则查询等待补充输入；停止请求已发出”。不能显示规则已核实或所有动作已停止。编码 Agent 保存 ACP 会话与当前工作、A2A `T-27` 的关联；规则助手另保存 `T-27` 与 MCP 请求 `42` 的关联。本地只能记录远端允许报告的状态，不能假定能直接管理远端请求。

编码 Agent 在把项目内容发往 A2A 远端之前就应阻止上传：先判断必要性、数据共享权限和用户授权范围。停止流程中，分别检查 ACP 带取消原因的前台结束更新、A2A 返回的任务状态，以及规则助手对其内部 MCP 请求的处理结果。MCP 取消通知不保证有确认响应；若远端状态不可见，应明确记录未知，不能补写“已取消”。

</details>
