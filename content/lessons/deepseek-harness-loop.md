# DeepSeek Harness 执行链：模型回复怎样变成工具调用

模型给出 `read` 和一串 JSON，文件却不会因此自动被读取。还需要程序收齐参数、找到函数、检查输入、运行函数，再把结果放回下一次模型请求。Harness 是承载这些工作的运行系统；Agent loop 是其中驱动“请求模型—执行工具—继续请求”的循环。本篇沿 DeepSeek Harness 的实际路径解释这次交接。

先修是 [DeepSeek Harness 入门](#/lesson/deepseek-harness-intro)、[Function Calling](#/lesson/function-calling) 和 [工具可靠性](#/lesson/tool-reliability)，文中会重新解释执行链上的术语。核验日期为 2026-10-03，核心依据是官方 `dsh-v0.1.7-rc.2` 标签对应提交 `477b4f420553e8a52c2fbccc464d7561b239c443` 的本地源码，CLI 包声明版本 `0.1.7-rc.2`。另与 master 提交 `da00f7f5358f2949383b35c14f548bc20187d80c` 对照。本文没有执行真实模型请求，也没有验证已安装 npm 包与标签文件逐项相同；master 的新增机制会单独说明。[发布标签版本文件](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/apps/cli/package.json)

## 先区分工作的层次

User 是输入的发起者；消息中的 `user` role 则是协议角色，不能单凭它推断内容全部由人输入，Harness 也能注入上下文。Agent 是活着的执行对象，有 inbox（待处理消息队列）、状态、取消接口和关联的 Session。Session 是会话事件日志：它保存已经接纳的事实，模型历史从日志推导出来。恢复时可以重新创建 Agent，继续驱动已有 Session，而不是让旧进程一直活着。[消息来源类型](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/llm/llm/src/message.ts)、[Agent 接口与 inbox](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/docs/subsystems/core.md)

这些层次不是一棵包含所有对象的树。Agent 驱动 Session 内记录的工作边界，工具则是可注册的能力：

| 名称 | 这里的含义 | 读文件后回答的示意 |
| --- | --- | --- |
| Turn，轮次 | 从接手输入到结束的一轮工作 | 整个读文件任务 |
| Step，步骤 | 一次接纳输入、请求模型并处理回复的边界 | 第一步读文件，第二步回答 |
| attempt，请求尝试 | Step 内的一次模型请求 | 请求失败后可在同一 Step 重试 |
| Tool，工具 | 注册表内的定义及执行函数 | `read` 的定义与函数 |
| tool call，工具调用请求 | 模型选择工具的一条结构化记录 | 调用 ID、名字、参数字符串 |

一个 Step 可以含多个工具调用；一个 Turn 可以含多个 Step。`agent/pre-step` 若拒绝输入，Turn 甚至可以不消耗 Step。成功请求没有工具调用时通常结束；工具结果一般促使下一 Step 请求模型，但结果也可以声明结束 Turn。这里的轮次是运行系统边界，不等于网页上显示的一条气泡。[生命周期图](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/docs/agent-lifecycle.md)、[停止条件源码](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/core/agent-loop/src/agent.ts)

## 请求怎样构建，回复怎样收齐

输入进入 inbox，driver（循环驱动程序）被唤醒并开启 Turn。它领取待处理消息，组装 system prompt 与当前可见工具定义，再经过 `agent/pre-step` 决定接纳哪些输入。通过后记录 `step/start`。`agent/request` 允许扩展代码确定 provider、model 等配置，`ctx.llm.prepareCall()` 解析实际模型能力，并绑定这一次使用的 adapter（模型适配器）。完成这些异步准备后，才提交 system 和 user 消息。[构建前半段](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/core/agent-loop/src/agent.ts)

接着记录必要的 `request/header` 和 `request/context`，用 `session.deriveMessages()` 从日志生成历史。请求对象及其消息被冻结，避免调用途中被别的代码改写；取消信号仍随请求传递。准备好的请求只能派发一次，配置必须与准备时相符，不能准备一种路由后偷偷用另一种。[请求构建](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/core/agent-loop/src/agent.ts)、[LLM 绑定](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/llm/llm/src/index.ts#L929-L978)

模型协议层负责传递消息、工具声明与流式结果。此版 DeepSeek adapter 请求 `/messages`，读取 Server-Sent Events（SSE，服务器连续发送的事件流），把协议事件转为内部 `StreamChunk`。工具参数可能分几段到达。`BlockAssembler` 按内容块索引累计 `argumentsDelta`，组成含 `id`、`name`、`arguments` 的 `tool-call` block。循环先收完本次流并提交 `assistant/message`，随后才提取工具调用；收到工具名的第一段时并不立即执行。[适配器](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/llm/llm-deepseek/src/adapter.ts)、[事件翻译](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/llm/llm-deepseek/src/translate.ts#L104-L173)、[内容组装](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/llm/llm/src/assembler.ts)

## 一个完整的文件读取例子

以下是按源码机制手工展开的示意，文件内容和模型回复是假设，未实测。用户输入：“读取 `/workspace/note.txt`，告诉我 timeout 是多少。”假设文件有两行：`timeout=30` 与 `retries=2`。真实工具名是 `read`，参数名是 `file_path`、`offset`、`limit`；有些框架叫它 `read_file`，名称并非统一协议。[实际工具定义](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/fs/tool-fs/src/read.ts#L70-L92)

Step 1 的请求含 system prompt、用户消息，以及下面这个简化的工具 schema（结构定义）；执行函数留在 Harness 中，不发送给模型：

```json
{
  "name": "read",
  "description": "Read a UTF-8 text file and return line-numbered content.",
  "parameters": {
    "type": "object",
    "properties": {
      "file_path": { "type": "string" },
      "offset": { "type": "number" },
      "limit": { "type": "number" }
    },
    "required": ["file_path"]
  }
}
```

假设 adapter 送来两段参数文本，assembler 将它们拼起来。下面展示内部事件的关键字段，不是可直接调用的 API 请求：

```json
[
  {"type":"tool-call-delta","index":0,"id":"call_1","name":"read","argumentsDelta":"{\"file_path\":\"/workspace/note.txt\""},
  {"type":"tool-call-delta","index":0,"id":"call_1","argumentsDelta":",\"offset\":1,\"limit\":2}"}
]
```

最终 block 的 `arguments` 是字符串 `{"file_path":"/workspace/note.txt","offset":1,"limit":2}`。调度器解析它，记录 `tool/call`，注册表放行后运行文件工具。假设文件系统返回成功，工具产出结构化值：

```json
{
  "path": "/workspace/note.txt",
  "offset": 1,
  "lines": [
    {"number": 1, "text": "timeout=30"},
    {"number": 2, "text": "retries=2"}
  ],
  "totalLines": 2
}
```

注册表验证输出值并调用工具的 `render`，生成模型可读的带行号文本；写入 `tool/result` 的 tool-role 消息关联 `call_1`。Step 2 再从 Session 推导历史，因此同时带上原用户输入、assistant 的调用请求和对应结果。DeepSeek adapter 把它们编码为 `tool_use` 与引用同一 ID 的 `tool_result`；假设模型回复“timeout 是 30”，没有新工具调用，Turn 结束。这里是两次模型请求、一次文件读取，并非模型自己打开文件。[输出处理](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/core/tools/src/index.ts#L1831-L1863)、[协议序列化](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/llm/llm-deepseek/src/serialize.ts#L115-L164)

## 从字符串到执行体，中间还有什么

`executeToolCalls()` 对参数调用 `JSON.parse`；空字符串变成 `{}`，无效 JSON 则保留原字符串。保留不是接受：后续工具仍会验证它。注册表为执行输入生成独立快照，运行 `tools/pre-execute` 前置处理，必要时询问批准，再运行只能拒绝或不表态的 guards（守卫检查），随后通过 `tools/execute` 派发。[参数解析](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/core/agent-loop/src/tool-calls.ts#L61-L110)、[执行管线](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/docs/tool-execution-pipeline.md)

dispatch（派发）就是按名字和 Agent 的可见范围查找当前定义，再调用 `tool.execute(args, exec)`，不是把名字拼成 JavaScript 代码执行。未知工具产生错误。第一方工具通常由 `defineTool` 包装：包装层在用户写的执行函数前验证 JSON Schema，不符合时抛 `ToolArgsError`。直接注册的其他定义仍需自行验证和收窄参数类型，不能推断注册表替所有工具做了同样的输入验证。[动态查找](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/core/tools/src/index.ts#L1564-L1590)、[defineTool 验证](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/core/tools/src/schema.ts#L554-L640)

schema 通过也不代表参数有实际意义。`read` 的 `offset` 声明为 number，工具体仍检查它是正整数、`limit` 不超过配置上限，路径非空，并通过文件系统后端解析目标。schema 也不决定调用者是否有权读这个路径，授权依赖实际策略和执行环境。向模型发送 schema 更不能证明服务端采用了 constrained decoding（约束解码）；它是否限制生成时的 token，属于模型服务实现，需要单独证据。[read 的值约束](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/fs/tool-fs/src/read.ts#L42-L66)

执行后先验证输出并生成内容，定义自己的 `projectContent` 可在后置策略前提供准备好的文本。随后 `tools/post-execute` 可阻止或改写结果，`finalizeContent` 执行最后的内容约束，同步的 `tools/result` 通知观察最终结果，然后记录 `tool/result`。后置处理改变的是结果，不会倒转执行体已经造成的副作用。上述事件中的 waterfall（瀑布式处理）指监听器可以包裹后续处理，并用 `next()` 委托下游。它是 Harness 的扩展机制，与模型生成工具参数是两回事。[执行管线](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/docs/tool-execution-pipeline.md)、[事件机制](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/docs/architecture.md#events)

## 并行、失败与取消的代价

一次回复可以提出多个调用，但只有工具的 `isConcurrencySafe(args)` 明确返回 `true`，调用才允许并行。没有声明、名称不可见、分类抛错或参数不合法时，调度模式是 exclusive（独占）。独占调用形成屏障；并行组使用受 `maxParallelToolCalls` 限制的滚动池。前置处理按模型顺序，执行体可以重叠，后置处理与结果提交仍按模型顺序。因此第二个调用先完成，也要等第一个结果提交；启动前还会重新分类，避免注册变化后继续用旧判断。[分类规则](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/core/tools/src/index.ts#L1297-L1312)、[调度源码](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/core/agent-loop/src/tool-calls.ts#L113-L262)

普通工具异常归一化成 `isError` 结果，模型可在后续 Step 判断是否换参数；loop 没有为每个失败工具无条件重试。模型请求的终态错误先记录为 `assistant/attempt`，`agent/request-error` 返回 retry 动作才在原 Step 内重新准备请求。它复用该 Step 已渲染的 prompt，用户消息只提交一次，不重复 `pre-step`。流读取直接抛错还有单独的记录与退出路径，不能把所有失败统称“自动重试”。[请求错误路径](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/core/agent-loop/src/agent.ts)

取消也是协作式的。调度器停止启动新调用，等待已启动调用结束，并为未启动调用写入合成错误结果，保持调用与结果可配对。取消信号不会撤销已发生的文件修改，也不能强行终止忽略信号的函数。流中已展示的安全文本前缀可以保留；失败尝试的流记录用于追查，不直接加入模型历史。若进程在流结算前硬退出，完整尝试记录仍可能丢失。[取消与排空](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/core/agent-loop/src/tool-calls.ts#L231-L289)、[Session 边界](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/docs/architecture.md#session-log)

内部调度器失败与普通工具报错还要区分：发布标签的失败路径排空已启动执行后抛错，可能留下没有结果的调用记录。对照的 master 新增 `ToolCallRecovery`，在 Step 异常时尝试补齐未完成调用的错误结果。这项改善不应写成 npm `0.1.7-rc.2` 已有能力。[发布版调度说明](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/core/agent-loop/src/tool-calls.ts#L1-L15)、[master 恢复路径](https://github.com/deepseek-ai/deepseek-harness/blob/da00f7f5358f2949383b35c14f548bc20187d80c/packages/core/agent-loop/src/agent.ts#L328-L357)

这些机制增加等待与处理成本：完整回复收齐后才执行工具，工具结果交回模型通常又需要一次调用；有序提交可能被慢工具阻塞；冻结、验证和日志有额外开销。并行上限不证明调用没有语义冲突，保存日志也不等于副作用可回滚。插件怎样插入执行链，见 [插件与 Cordis](#/lesson/deepseek-harness-plugins)；恢复状态与安全边界另见 [状态与安全](#/lesson/deepseek-harness-state-security)。

<details>
<summary>面试怎么回答</summary>

约一分钟的口头回答：DeepSeek Harness 把模型工具协议接到真实程序上。Agent 领取输入，在 Turn 内开启 Step，组装 prompt 和工具声明，绑定 adapter，再从 Session 日志构建冻结请求。adapter 把流式协议转成内部内容块，收齐后 loop 提取工具调用，解析 JSON，按注册表和可见范围派发。`defineTool` 在执行体前验证参数，策略管线决定放行与结果处理。结果带调用 ID 写回 Session，下一 Step 的模型请求就能看到它。多个工具只有明确声明并行安全才重叠执行，结果仍有序提交。取消会排空已启动任务，重试依赖相应错误处理机制，不能保证撤销副作用。

**追问一：参数符合 schema，为什么还会失败？** 类型检查不能证明路径存在、offset 是允许的值或调用者有权限。`offset: 0` 符合 number 类型，却会被 `parseReadArgs` 拒绝；文件系统和策略还会继续检查。

**追问二：第二个并行工具先完成，为什么不先交给模型？** 本实现保持模型提出调用的顺序，后置处理和日志提交也按这个顺序。结果与上下文顺序可预测，但承担前一个慢调用造成的等待。

**追问三：重试还是原来的 Step 吗？** 模型终态错误经 `agent/request-error` 获准重试时，是原 Step 的新 attempt；它不会再次提交同一用户消息。工具错误通常是结果，随后由新 Step 的模型作下一步选择。

</details>

练习：模型依次提出 `read(A)`、`read(B)`、`write(C)`。假设两个 read 都声明并行安全，write 未声明，上限为 2。B 先完成、A 后完成；随后 write 启动且已修改文件，用户此时取消。画出启动与结果提交顺序，说明哪些事实不能从“已取消”推出。

<details>
<summary>参考思路</summary>

A、B 可重叠执行，B 的执行体先结束仍不能越过 A 提交。A、B 的结果按顺序提交并排空后，独占的 write 才启动。取消后等待已经开始的 write 到达结束边界，最终记录取消结果；已经发生的修改不自动撤销。如果 write 忽略取消信号，等待可能很长。取消状态不能证明文件未变化，也不能证明操作可安全重试，仍需核对真实文件状态。

</details>
