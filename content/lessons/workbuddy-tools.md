# WorkBuddy 的工具层：会话怎样取得一个可调用的 MCP 工具

假设你让 WorkBuddy“查询订单 O-18 的状态”。设置页显示订单 MCP 已连接，模型却没有发起查询。即使模型后来输出了 `lookup_order` 调用，也可能因权限或登录状态失败。连接成功、模型知道接口、调用获准和订单查询完成，是这次请求的不同阶段。

WorkBuddy 是桌面 Agent 应用，**工具层**负责把模型提出的调用接到实际执行入口。MCP client 是代表应用与 MCP server 交换消息的客户端组件；模型负责选择工具和生成参数，协议请求由客户端发送。应用还要做**会话投影**：从已注册或发现的能力中，按当前任务的配置筛出可供这一会话使用的工具定义。投影既要让模型知道怎样调用，也要让执行入口知道调用属于哪个会话。

本篇沿 O-18 查询，解释发现、投影、参数格式、身份和结果。订单服务、工具名与返回内容均为教学假设，不是 WorkBuddy 已内置的订单功能或真实日志。实现依据是 WorkBuddy 5.6.2 安装包的静态代码：2026-09-28 建立快照，2026-10-01 复核关键片段；整包 SHA256 为 `c4304eec1f8849ea16b9492f02dcc5d1e93be4a7aed184b7effaabd2f06c9d22`。没有运行供应商代码、读取用户配置或捕获模型请求。前置知识见 [Skill 加载](#/lesson/workbuddy-skills)、[Agent 权限与安全](#/lesson/agent-security)；协议和参数机制可回看 [MCP](#/lesson/mcp) 与 [Function Calling](#/lesson/function-calling)。

## tools/list 先发现接口，会话再决定使用范围

订单服务假设暴露了 `lookup_order`。客户端先与服务端初始化，交换协议版本和能力声明，再查询工具清单。WorkBuddy 的 `SdkRemoteSession.listTools` 先检查 server capabilities；未声明 tools 时返回空列表。prompts、resources 也分别检查自己的能力位，缺少它们不会让只提供工具的 server 自动变成连接失败。这是能力协商后的分类处理。[MCP 生命周期规范](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle)、[实现定位：S41](https://jiuchenm.github.io/workbuddy-study/#S41)

`tools/list` 返回工具名称、说明和输入 schema。Schema 是参数的结构约束：有哪些字段、类型是什么、哪些必须填写。它把“这个服务可能帮我查订单”变成可调用的接口描述；清单仍需经过应用筛选，才能进入当前会话。WorkBuddy 的 MCP Manager 用 `enabled`、`trusted` 判断连接是否被阻断，connector 还需匹配当前 session 的启用集合；带 sessionScopeExempt 的 connector 有例外。browser-use 另有会话开关。连接对象只有未 stopped 且 connection fingerprint 与新配置一致才可复用，工具名字相同不能证明连接没变。[MCP 工具规范](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)、[实现定位：S22](https://jiuchenm.github.io/workbuddy-study/#S22)

因此，O-18 查询没有进入模型候选时，应区分未声明工具能力、连接未启用、尚未信任和当前会话未选择连接。改 Prompt 无法替应用补齐这些条件。即使连接已就绪，本轮模型是否真正收到某个定义，也要检查当轮输入；设置页和发现清单都不能替代这个证据。

App 自己的 builtin tools 还有独立规则，不能把它套到所有第三方 MCP。`resolveSessionBuiltinToolNames` 区分普通、延迟加载和 explicit-only 工具。延迟加载首先控制能力曝光与发现方式，不自动表示工具进程尚未启动，也不免除调用许可。[实现定位：S21](https://jiuchenm.github.io/workbuddy-study/#S21)

这段代码的关键条件需要一起读：

- toolSpecs 为空或未提供时，先行分支返回所有非 explicit-only 注册工具，包含延迟项。
- toolSpecs 非空时，普通工具仍可用；延迟项需要 `ToolSearch` 或对应的 `Defer(工具名)`。
- `workbuddy_request_mcp_connection` 属于 explicit-only，需要显式名字或对应 Defer，不能仅凭 ToolSearch 开放。历史裸名和带前缀别名仍用于兼容。

Skill 说明任务方法，工具定义说明调用接口，permission mode 控制动作许可，MCP Manager 管连接与会话范围。这些信息可能同时影响 O-18 任务，但不能互相替代。

## 参数 schema 与会话签名各保护什么

假设筛选后，订单会话取得下面的定义。代码块只展示教学示例，省略协议信封：

```json
{
  "name": "lookup_order",
  "description": "查询指定订单的状态",
  "inputSchema": {
    "type": "object",
    "properties": { "order_id": { "type": "string" } },
    "required": ["order_id"]
  }
}
```

模型据此提出 `lookup_order`，参数为 `{"order_id":"O-18"}`。Schema 约束参数形状，不能证明 O-18 存在，更不能证明用户有权查看它。工具定义进入上下文也不能证明调用已经执行；模型输出的是调用请求，运行时还要处理参数与身份。

这里必须分清两条路径：订单例子使用第三方远端 MCP；CLI 若要调用桌面 App 持有的 builtin 能力，则通过本地 MCP host 回到 App Server。本地投影与签名是后一条路径的实现，不能据此声称每个第三方 server 都验证 WorkBuddy 的信封。

本地路径中，`createWorkbuddyMcpConfig` 要求 host 已取得有效端口，再按 allowed tool 集合投影注册表，保留 defer 元数据和兼容别名，生成指向 `127.0.0.1` 的 HTTP MCP 配置。本地服务的列表接口返回 `name`、`description`、`inputSchema` 等字段，CLI 因而可以通过 MCP 使用宿主接口，无须直接引用 Electron 对象。[实现定位：S37](https://jiuchenm.github.io/workbuddy-study/#S37)、[S40](https://jiuchenm.github.io/workbuddy-study/#S40)

配置还有两份身份材料。Bearer token 对应一条本地路由；上下文信封带 sessionId、workspace、可用 builtin tools 等字段，由 daemon 用 HMAC-SHA256 签名，CLI 回传。签名是校验上下文来源与完整性的密码学机制，与前面的参数 schema 不同；服务端验签后仍解析和校验字段。Base64 编码本身不提供这种保证。[实现定位：S38](https://jiuchenm.github.io/workbuddy-study/#S38)

两个会话可能走同一路由，复用该路由 token，却携带不同的签名上下文。实现将 token 保存在进程内映射，同一路由重复签发会复用，撤销与清空随路由或服务生命周期发生，没有单独的时钟 TTL。这样避免静态配置因时间经过突然失效，也使正确撤销成为生命周期责任。

LocalMcpHost 绑定回环地址后仍检查 Host 主机名和端口；有 Origin 时还要命中允许集合，再验证路由 token 与签名上下文。校验通过后删除两项本地认证头。回环只说明监听位置，路由凭据和信封分别约束入口与会话，领域服务仍负责具体资源授权。本次未验证全部入口能否被绕过。[实现定位：S39](https://jiuchenm.github.io/workbuddy-study/#S39)

## credential 要在真实请求时取得

回到远端 O-18 查询。Credential 是服务端验证调用者身份所需的凭据；用户刚续期的票据若只保存在新配置里，旧连接仍可能带着旧 header 请求。WorkBuddy 的 transport 用 `createAuthorizingFetch` 包装 fetch，每次请求调用授权来源并合并 header，让现有连接有机会使用新凭据，而非只在构造连接时取一次。[实现定位：S41，main/server.js L39635–39676](https://jiuchenm.github.io/workbuddy-study/#S41)

这个包装器还保存认证响应信息，以请求前的 sequence 区分此次操作和此前请求。若 O-18 请求收到 401，错误补充应关联此次认证 challenge，不能拿旧请求的认证失败解释它。这个实现提供了动态取凭据和错误关联的条件；它不证明本机已有有效登录，也不保证凭据刷新后上游必然放行订单。

工具清单也可能在会话中变化。`SdkRemoteSession` 订阅工具列表变化通知，收到后重新 listTools，再交给监听者。通知本身不携带完整清单，不能当成“新增一个工具”的增量；重拉失败会记录警告。即使重拉成功，后续投影和上下文仍有自己的更新时机，不能据此断言正在生成的这一轮模型输入已同步更新。

还有一种容易误判的空结果：资源模板查询的注释讨论“方法不支持”，实际 catch 却对捕获的错误都警告并返回空列表。所以空模板列表可能表示无能力，也可能表示查询失败被归一为空。需要回查对应请求与日志，不能只凭 UI 空数组判断 server 正常。

## 执行入口复查，结果再回到模型

假设 O-18 的调用通过会话许可与上游身份检查，客户端发送 `tools/call`，服务端查询后返回内容。教学假设的成功内容为 `{"order_id":"O-18","status":"shipped"}`，工具结果标记 `isError: false`；运行时把结果带回模型，模型才有依据回答“订单 O-18 已发货”。HTTP 响应完成、工具未报错和业务字段支持答案，是三层不同的证据。[MCP 工具规范](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)

失败同样需要进入这条链：上游返回认证失败，就只能报告查询受阻；工具返回 isError，则应处理工具错误。即使 isError 为 false，若业务内容表示订单未找到，也不能回答已发货。将“收到响应”写成“任务完成”，会把传输状态误当成业务事实。

本地 builtin 路径给出了明确的执行入口检查。WorkbuddyMcpServer 收到调用后重新查 registry，再检查工具是否属于 `context.allowedToolNames`；工具不存在或不允许就返回错误结果。列表也按该集合过滤。通过后才调用 handler，handler 异常会转为 `isError: true` 的工具结果。[实现定位：S40，main/server.js L43578–43644](https://jiuchenm.github.io/workbuddy-study/#S40)

因此，订单会话即使保留了某个旧 builtin 定义，模型提出调用时仍需服务端复查。工具级允许也不等于文件、订单或账号范围的授权。不过，此处 allowed 集合来自已签名上下文，可能是签发时的快照。权限收紧后旧信封如何失效、投影配置如何替换，还需要沿配置更新和路由撤销链验证；这次没有做时序测试，不能声称新权限立即覆盖全部在途调用。

CLI 的工具 Hook 是执行前后的扩展点。PreToolUse helper 可接收许可决定、修改后输入和原因，PostToolUse 可补上下文或替换输出；callId 也用于关联开始时间、成功与失败遥测。但该 PreToolUse helper 捕获执行异常后返回 `allowed=true`，只说明这个扩展点的异常策略倾向继续。模式许可、本地入口、会话名单和上游授权仍是其他层，局部 helper 不能证明全局无条件放行。如果关键策略只依赖这个 Hook，则须核查异常时能否真正阻断。[实现定位：S23](https://jiuchenm.github.io/workbuddy-study/#S23)

诊断 O-18 查询时，应关联同一次调用的 session、工具名、callId、入口决策与上游结果；涉及文件交付还要关联产物状态。先定位断在哪个阶段，再决定改连接、上下文、身份或工具处理。文档保存与验收见[下一篇](#/lesson/workbuddy-artifacts)。

<details>
<summary>面试怎么回答</summary>

一分钟回答：桌面 Agent 的工具层把模型调用接到执行入口。MCP client 先发现工具，再按连接信任和会话范围投影定义，模型按 schema 生成参数。定义可见不等于调用获准或任务成功。WorkBuddy 的 builtin 路径通过本地 MCP host 使用路由 token 与签名会话上下文，服务器调用时还复查允许集合；第三方远端路径则在每次请求时取得授权 header。工具清单变化需要重拉并更新投影。最后要看工具错误和业务内容，才能回答订单问题；这些结论只限固定安装包的静态实现。

追问一：工具已在上下文，为什么不能算授权？上下文提供模型候选，可能已经过时。执行入口仍要检查调用，业务服务还要检查资源范围；schema 通过也只证明参数形状满足约束。

追问二：回环服务为什么还验 Host 和会话？回环限制监听位置，Host/Origin 约束入口，路由 token 约束路由，签名信封绑定会话上下文。它们处理不同问题，均不能替代业务资源授权。

追问三：Hook 抛错后继续是不是漏洞？需要确认关键策略是否只在该 Hook 中、外层是否有强制门禁、异常如何记录。局部 allowed=true 不能直接推断全局结果，也不能当作可靠阻断保证。

追问四：收到 tools list changed 是否表示模型马上看见新工具？通知要求重拉完整清单。重拉、会话投影和本轮模型输入更新仍有各自时机；必须核对该轮输入才能确认。

</details>

练习：O-18 查询已经发现工具 T，模型按 schema 生成了参数。用户随后禁用 T，旧模型请求仍产生一次调用；本地路由 token 有效，上游也允许该用户查询。你还缺哪些证据，才能判断此次调用能否执行，以及查询是否完成？

<details>
<summary>练习参考思路</summary>

先确认 T 实际走 builtin 还是第三方路径，不能给所有 server 套用同一个信封检查。若走 builtin，查本次绑定的签名上下文、允许集合，以及禁用是否触发配置更新、旧信封失效或路由撤销。记录配置版本与签发、禁用、调用时序；只握有旧信封与当前 UI 截图仍不足以证明收紧覆盖了这次调用。若走远端，查此次会话策略和实际请求的身份结果。两条路径最终都要看真实工具结果与订单业务字段，上游允许该用户查询并不证明当前 Agent 会话获准调用，也不证明订单状态已经取得。

</details>
