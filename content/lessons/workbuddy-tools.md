# WorkBuddy 的工具层：会话怎样取得一个可调用的 MCP 工具

假设桌面上同时打开两个任务。任务 A 在整理本地文档，任务 B 在查询一个已连接的服务。两个任务都由同一个 App 启动，却不应自动获得对方的全部工具。再假设远端 MCP 在运行中新增了工具，或者登录凭据刚刚刷新。应用既要更新能力，又不能让旧配置把正在运行的任务弄坏。这时，“把 tools/list 的结果交给模型”只完成了很小的一部分工作。

WorkBuddy 5.6.2 的工具实现分布在 App Server、CLI 和领域服务中。本篇沿着配置生成、会话身份、能力查询、实际调用解释它们的分工。先修是 [MCP](#/lesson/mcp) 和 [Function Calling](#/lesson/function-calling)；Skill 目录怎样加载见[上一篇](#/lesson/workbuddy-skills)。下面的任务 A、B 和工具名例子是教学假设；实现事实来自 2026-09-28 读取的安装包，不是一次真实调用日志。

## 模型的工具表由哪几层共同决定

先看 App 自己提供的 builtin tools。`main/server.js` 中的 `resolveSessionBuiltinToolNames` 接收注册表和会话的工具规格。它区分普通工具、延迟加载工具以及只能显式开放的工具。当工具规格非空时，延迟工具需要规格里有 `ToolSearch`，或者明确写了 `Defer(工具名)`，才满足这一分支的开放条件。规格为空或未提供时，函数的先行分支直接返回所有非 explicit-only 注册工具，包含其中的延迟项；`workbuddy_request_mcp_connection` 属于 explicit-only，不能仅因为存在 ToolSearch 就放行。[实现定位：S21](https://jiuchenm.github.io/workbuddy-study/#S21)

这里的“延迟”首先描述能力曝光和发现方式。它不自动表示工具进程尚未启动，更不表示调用时可以跳过许可。不同机制可能一起使用，却各自管理不同对象：Skill 描述任务方法，工具定义描述可调用接口，permission mode 管动作许可，MCP Manager 管连接与会话范围。

例如，假设注册表有普通工具 `show_summary`、延迟工具 `lookup_archive`，以及上述 explicit-only 工具。会话只带 `ToolSearch` 时，延迟项可以进入相应可用集合，但 explicit-only 项仍不因此开放。这个例子解释的是 builtin policy 的一个分支，不是说所有第三方 MCP 都遵循同一张工具名单。

第三方连接还有另外的筛选。可见代码用 `enabled` 和 `trusted` 决定连接是否被阻断，connector 再与当前 session 的启用集合匹配。browser-use 也有自己的 session 开关。连接对象可复用的条件包括它没有停止，而且 connection fingerprint 与新配置相同。工具名字相同并不足以证明连接仍可复用。[实现定位：S22](https://jiuchenm.github.io/workbuddy-study/#S22)

因此排查“模型没有调用某个工具”时，需要先判断工具是否出现在本轮候选里。没有连接、未信任、会话未选择、延迟能力尚未被发现、参数不合适，是不同原因。只修改 Prompt，不能修复所有这些情况。

## CLI 怎样调用桌面 App 持有的能力

CLI 要使用 App 内的能力，必须跨过进程边界。`createWorkbuddyMcpConfig` 为内置工具生成一个指向本地回环地址的 HTTP MCP 配置。代码要求本地 host 已经取得有效端口，按 allowed tool 集合投影注册表，并为工具保留 defer 元数据和兼容别名。这个配置让 CLI 能通过统一工具协议回到 App Server，而不必直接引用 Electron 的全部对象。[实现定位：S37，main/server.js L43708–43857](https://jiuchenm.github.io/workbuddy-study/#S37)

配置里有两份用途不同的信息。一份 Bearer token 对应本地路由；另一份上下文信封带 sessionId、workspace、可用 builtin tools 等会话信息。信封由 daemon 用 HMAC-SHA256 签名，调用方负责回传。它不是将 JSON 做 Base64 后就相信其中的身份：服务端验证签名、解析结构，再交给路由处理器。[实现定位：S38，L43885–43977](https://jiuchenm.github.io/workbuddy-study/#S38)

可以用一个简化的责任顺序理解它；下面是重新组织的教学伪代码，不是供应商原文：

```python
def accept_local_call(request, route):
    require_route_token(request, route.key)
    session_context = verify_signed_context(request)
    require_valid_fields(session_context)
    return route.handle(request, session_context)
```

路由 token 回答“这份凭证是否发给这条路由”，上下文信封回答“宿主为哪个会话签发了什么上下文”。两个任务可能走同一条 builtin 路由，却携带不同的签名上下文。不能把“每路由 token”误读为“每会话一套 token”。实现中的 token 保存在进程内映射，重复签发同一路由时复用，撤销和清空随着路由或服务生命周期发生；没有另外设一个时钟 TTL。这个选择避免旧配置在任意时间点突然过期，但也要求生命周期撤销正确。

本地监听并不等于可以省略入口检查。可见 LocalMcpHost 绑定回环地址，同时验证 Host 的主机名和端口；带 Origin 的请求还需命中允许集合。随后才验路由 token 和上下文，成功后删除两项本地认证头。此处描述的是代码中的防护步骤，没有对全部入口做渗透或绕过验证。[实现定位：S39，L44128–44219](https://jiuchenm.github.io/workbuddy-study/#S39)

## 看得见一个工具，仍要在调用时检查

列表查询与执行可能相隔数秒甚至更久。两者之间用户能切模式、禁用连接，也可能只是模型保留了一份过时工具说明。只在展示工具时过滤，不能保证之后收到的调用合法。

WorkbuddyMcpServer 的调用处理会重新从 registry 找工具，并检查它是否属于 `context.allowedToolNames`；找不到或不允许时返回错误结果。列表接口也按同一集合过滤。这使服务器的调用入口拥有实际判断，而不是信任模型“只会调用给它展示过的名字”。[实现定位：S40，main/server.js L43591–43638](https://jiuchenm.github.io/workbuddy-study/#S40)

回到任务 A、B。假设 A 的已签名上下文只允许 `show_summary`，模型却产生 `lookup_archive` 调用。正确的阻止位置是服务端调用检查，不能靠界面上没显示这个工具就当作安全。即便通过工具名单，领域服务仍可能拒绝具体资源访问：工具级允许与文件、订单、账号范围的授权不是同一种判断。

这里也存在一个不能从局部代码推断的部分：旧信封携带的是签发时的工具集合。运行中收紧权限后，旧信封如何失效、已投影配置怎样替换，需要沿配置更新和路由撤销链继续验证。本轮没有做这个时序测试，所以不能将签名机制直接总结成“权限变化立即覆盖所有在途调用”。

## 上游 MCP 的变化怎样进入会话

远端 MCP transport 查询能力前先读 server capabilities。没有声明 tools 时，listTools 返回空集合；没有 prompts 或 resources 也分别返回空，而不是把只实现工具的 server 判定为连接失败。这与 MCP 的初始化、能力协商阶段有关：客户端只能按双方声明的能力使用协议。[MCP 生命周期规范](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle)

WorkBuddy 的 `SdkRemoteSession` 还订阅 tools list changed 通知。通知到达后重新 listTools，再把新的列表交给监听者。通知并不携带完整工具清单，不能把它当成“多一个工具”的增量记录。若重拉失败，该分支记录警告；此事实也不等于模型的本轮输入一定立刻刷新，因为后续投影和上下文更新仍有自己的生命周期。[实现定位：S41，main/server.js L39536–39660](https://jiuchenm.github.io/workbuddy-study/#S41)

动态凭据同样不能只在连接构造时取一次。该 transport 的 fetch 包装器在每次请求时调用授权来源并合并 header，还将这次 401 的 challenge 与请求前的 sequence 对齐。这样新凭据有机会用于现有连接，错误诊断也不会随便拿上一次请求的认证失败解释这一次调用。

能力可选的兼容逻辑需要仔细读。资源模板查询的注释主要讨论“方法不支持”，实际 catch 却对捕获的错误都警告并返回空列表。因而“资源模板列表为空”可能是能力确实没有，也可能是该分支掩平了失败。观察 UI 结果时，应继续看错误日志与对应请求，而不是只看空数组就下结论。

## Hook 补充执行流程，但不是唯一许可来源

CLI 的 PreToolUse helper 能接收 Hook 返回的许可决定、修改后输入与原因；PostToolUse 能补充上下文或替换工具输出。调用 ID 还被用于关联开始时间、成功与失败遥测。因此 Hook 可以承担格式转换、审计或领域收尾，而不只是在工具前打印一条日志。[实现定位：S23](https://jiuchenm.github.io/workbuddy-study/#S23)

但该 PreToolUse helper 捕获执行异常后返回 allowed=true。这里最多能说明这个扩展点的异常策略倾向于继续，不能推出整个工具系统都无条件放行：模式许可、本地路由校验、会话名单以及上游服务授权仍是其他层。反过来，如果团队只在这个 Hook 里写了一条关键策略，也不能假设异常时它仍会强制阻断。

一次完整调用的诊断记录至少要能关联会话、工具名、callId、入口决策、上游结果与产物状态。传输完成只证明响应结束，工具 isError 说明工具层是否报错，业务字段才说明实际工作是否完成。文档保存和产物验证的具体例子放在[下一篇](#/lesson/workbuddy-artifacts)。

<details>
<summary>面试怎么回答</summary>

一分钟回答：我会把桌面 Agent 的工具层分为能力注册、会话投影和调用执行。WorkBuddy 的可见代码对 builtin tools 处理普通、延迟和显式开放项；MCP Manager 另外处理连接、信任与会话选择。CLI 通过本地 MCP host 调用宿主能力，路由 token 与签名会话上下文分别约束路由和身份，执行入口还会复查允许工具。上游能力变化触发重新发现，凭据则在请求时取得。这样可以分别定位“没发现”“没权限”“没连接”和“执行失败”。

追问一：工具出现在模型上下文里，是否就算授权？不算。上下文是模型的候选信息，服务器仍需验证调用与资源访问范围。旧上下文可能保留已禁用能力，不能以模型选择替代服务端检查。

追问二：为什么回环服务仍要验证 Host 和会话？回环只限制监听位置，不能说明请求来自正确调用方。代码通过路由凭证、签名上下文以及 Host/Origin 检查处理不同问题；其中任何一项都不能代替领域资源授权。

追问三：Hook 抛错后继续执行是否意味着安全漏洞？仅凭这个 helper 不能下全局判断。应先确认关键策略是否只依赖它、外层还有哪些强制门禁，以及异常怎样被记录和上报。

</details>

练习：某会话原先能查询工具 T。用户禁用 T 后，旧模型请求仍返回一次 T 调用；本地 token 有效，上游也允许该用户查询。应该用哪些证据判断这次调用能否执行？

<details>
<summary>练习参考思路</summary>

先查此次调用实际绑定的 session 上下文和服务端允许集合，不能只看当前 UI 或上游授权。再查禁用事件是否触发投影更新、旧信封失效或路由撤销。若只握有原先签发的信封和当前 UI 截图，仍不足以证明实时收紧已覆盖这次在途调用。上游授权只说明身份具备业务权限，不说明当前 Agent 会话获准使用工具。测试应记录配置版本、签发/调用时序和实际拒绝位置。

</details>
