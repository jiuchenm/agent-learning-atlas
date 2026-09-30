# WorkBuddy 的会话恢复：预热、旧回调与请求重放

WorkBuddy 是让模型调用工具、处理文件的桌面 Agent 应用。这里的**会话恢复**是连接或执行进程失效后，重新建立继续任务所需的运行状态。它要回答两个问题：谁还能更新这段会话，上一条请求还能不能重新发送。假设用户要求“在工作簿新增一个汇总页”，工具完成了写入，返回结果却在本地连接断开时丢失。界面显示“连接失败”，用户点击继续。如果模型再次执行同一操作，工作簿可能多出第二个汇总页。

这与 [compact](#/lesson/compact) 处理长对话的机制不同。compact 整理模型下一轮要读的历史，恢复则处理进程、连接和未确认的请求。即使摘要完整写着“正在生成汇总页”，它也无法证明页面是否已经写入。**恢复了连接，只能证明通道重新可用；业务结果仍可能未知。**

另一个常见现象是第一条消息很慢，第二条明显更快。它可能与模型推理有关，也可能只是 CLI（命令行执行程序）加载模块、初始化插件和建立连接花了时间。WorkBuddy 将进程预热与业务会话恢复分开实现：预热是提前启动执行程序，让第一次请求少等一部分初始化；恢复是在连接断开后确认哪些对象仍有效、哪个请求可以再次发送。两者解决的是不同的等待与故障，不能把它们都归为“网络不稳定”。

本篇跟踪 WorkBuddy 5.6.2 中的 `CliPrewarmPool`（CLI 预热池）和 `CodeBuddyCodeSessionBackend`（管理一段会话的后端对象）。先读[会话入口](#/lesson/workbuddy-session)、[Agent 状态](#/lesson/agent-state)与[工具失败](#/lesson/tool-reliability)。原始静态核验日期为 2026-09-28；2026-10-01 复核了相关安装包片段。固定 `app.asar` 的 SHA-256 为 `c4304eec1f8849ea16b9492f02dcc5d1e93be4a7aed184b7effaabd2f06c9d22`。下文进程号、序号和时间顺序均为教学假设，没有执行 WorkBuddy 或供应商模块、读取用户配置、结束用户进程或注入断线。[快照与证据定位目录](https://jiuchenm.github.io/workbuddy-study/)提供源码位置索引，不能替代运行轨迹。

## 预热池究竟复用了什么

预热池保存已启动、等待激活的 CLI 进程，提前承担部分进程与模块初始化成本。在工作簿任务中，它可以为新会话提供执行程序，但没有缓存上次任务的推理答案。Backend 获取 runtime（承载会话的执行实例）时先尝试取得预热候选，再给它工作目录、参数、sessionId 和允许的环境增量；未命中或激活失败则回到 runtime manager 的冷启动路径。这里的 sessionId 标识逻辑会话，尚不证明这个进程已能处理业务。[获取逻辑：S02](https://jiuchenm.github.io/workbuddy-study/#S02)

这一步最容易漏掉环境一致性。假设预热进程启动时使用环境配置 E1，用户切换项目后要求 E2。进程已经启动，不代表它天然适合新项目。`tryAcquire` 先检查 session 环境增量中的键是否允许，再将候选的启动环境与本次增量合并，比较它与本次冷启动本应使用的 runtimeManagedEnv。存在差异时，候选被标记丢弃、从池中移除并终止，再安排补池。[比较与淘汰：S03](https://jiuchenm.github.io/workbuddy-study/#S03)

例如，候选对应某代理配置，当前会话已切到另一配置。仅复制 sessionId 并不能更新所有已经初始化的依赖。拒绝复用会多付一次冷启动成本，但可以避免新会话继续使用旧进程条件。这是代码允许的决策，不表示本机测出了多少性能收益。

命中候选之后还有激活确认。`doActivate` 发送 cwd、args、sessionId，并要求 ready ACK，即业务端点准备完成后的确认回复。IPC 是进程间通信；它能接收消息，与 CLI 的 ACP 会话通信端点已经可服务是两个阶段。收到 ready ACK 后，池验证返回的进程身份与会话身份，再使用实际端口。ping 只能观察进程是否响应，无法替代这次激活握手。若激活失败，池清理候选、安排带退避的补池，Backend 才继续冷启动；退避是在再次补充资源前留出等待，避免连续失败立即触发一轮又一轮启动。[激活握手：S55](https://jiuchenm.github.io/workbuddy-study/#S55)

可用下面的教学状态图理解主路径。它合并了若干实现细节，不是源代码里完整的枚举：

```mermaid
stateDiagram-v2
    [*] --> Spawning
    Spawning --> Idle: 初始化到可供获取
    Idle --> Discarded: 环境不匹配或探活失败
    Idle --> Claimed: 会话取得候选
    Claimed --> Serving: ready ACK与身份检查通过
    Claimed --> Discarded: 激活失败
    Discarded --> [*]: 清理并安排补池
    Serving --> [*]: 所属会话释放
```

图中的 Claimed 表示候选已被取走，Serving 才表示激活确认通过。实现中 tryAcquire 先将候选状态设为 activated，防止其他获取者再次选中；真正的 ready 确认随后发生。因此读取 activated 字段时，还要知道它处于哪个阶段，不能据此单独判断 ACP 已可服务。对于工作簿请求，只有会话继续完成连接和初始化后，Backend 才进入发送路径。

## 为什么把探活移出获取路径

如果每次取得候选前都同步 ping，就会把“观察进程健康”的耗时加入用户启动路径。更麻烦的是，进程刚监听 IPC 时可能仍在加载模块，事件循环繁忙。一次很短的探活超时可能只是没有及时响应，而不是进程永久失效。

可见代码把空闲候选的健康探测放到后台定时器，tryAcquire 主要同步读取状态和检查环境。激活自己仍有失败处理，所以取得候选并不免除后续验证。文件注释记载了过急探活导致误淘汰的历史，但其耗时数字是作者注释，不能当作本轮基准。探活等待结束后也会再检查候选是否仍 idle；如果这期间会话已取走候选，就不能按旧的探活结果终止它。[预热池检查范围：S03、S55](https://jiuchenm.github.io/workbuddy-study/#S03)

清理池也不能把正在服务的会话一并杀掉。flush 只选择 idle/spawning 候选，activated 会话由 session 生命周期管理。并发 flush 共享同一个进行中 Promise，完成周期内的补池意图被记录，避免每个配置变化都同时重建一批进程。daemon 停止时则有另一条 stop 路径，处理仍由池跟踪的全部资源。

启动时清理旧账的逻辑还检查 prewarm 标识和进程命令行，避免单凭 PID 文件杀掉后来复用这个 PID 的无关进程。这里管理的是操作系统资源身份。稍后会看到，会话事件也需要一个类似但不同的身份保护。

## 重连之后，旧回调为什么不能继续写状态

回到工作簿任务。假设会话 S 原先连接 runtime R1，R1 的“汇总页生成中”事件已经在路上。连接中断后，应用建立 R2；R1 的事件随后才抵达。两条事件都可能写着相同的 sessionId，因为用户仍处于同一会话。只比较 sessionId，界面可能又被旧进程改回“生成中”，甚至收到已经失效的权限请求。应用需要撤销旧实例的更新资格。

Backend 每次成功取得 runtime 时递增 `runtimeOwnershipEpoch`。epoch 是代际序号，用来区分同一会话先后使用的执行实例；client 是连接这个实例、接收事件的客户端对象。创建 client 时捕获当前 epoch，回调先比较它与当前实例的 epoch，还检查 client 是否仍在 activeCallbackClients 集合中。**代际匹配且 client 仍活跃**，才向上转发 session update、提问、权限请求或 transport activity。[回调筛选：S31](https://jiuchenm.github.io/workbuddy-study/#S31)

用整数模拟：R1 捕获 epoch=7；soft reset 释放它的所有权；R2 建立后使用 epoch=8。R1 的晚到消息即使 sessionId=S，也会因为 7 不等于当前 8 而被忽略。active client 集合还提供一次独立检查，使已停用 client 的回调失效。这些机制处理消息归属，不负责证明业务动作是否完成。

softReset 与 destroy 的后果也不同。softReset 递增 resetEpoch，停用旧 client 回调、清空连接和端点，并释放 runtime，但保留初始化请求及可继续使用的 backend 对象。下一次需要连接时重新初始化。destroy 则标记对象已销毁，同时清理关联临时配置和资源。工作簿连接断开后，softReset 给同一逻辑会话留下继续入口；destroy 终结这个对象的生命周期。[对象生命周期：S56](https://jiuchenm.github.io/workbuddy-study/#S56)

resetEpoch 还用来防止初始化过程在中途被重置后继续提交结果。一次异步初始化开始时记住 resetEpoch，在关键 await 之后检查；如果 reset 已经发生，旧初始化不能再把过时 client 安装回当前对象。runtimeOwnershipEpoch 区分谁拥有事件更新权，resetEpoch 判断初始化是否被抢先重置，两者处理不同竞态。单纯给请求加超时，无法回答“这次异步工作是否仍有资格提交”。

此时要分别观察三种状态：逻辑会话 S 仍可继续，原连接已经失效，汇总页可能已写入。softReset 改变了前两者之间的连接关系，却没有回滚工作簿。即使 R1 的完成事件被忽略，文件上已有的修改也不会因此消失。

## 同样是断线，哪些请求可以重试

prompt 路径先确保会话初始化，再通过 connection 发送请求。捕获错误后，代码区分本地 loopback endpoint 不可用与一般 transport（消息传输通道）故障。loopback 指 localhost、127.0.0.1 等回到本机的地址；下面两种恢复分类都先要求端点是本地地址，不能推广到任意远端故障。ECONNREFUSED、AGENT_UNAVAILABLE 一类会触发 soft reset 后重试一次；ECONNRESET、ETIMEDOUT、stream ended 等归入另一类，标记 `after_send_or_unknown` 和 replay unsafe，即请求可能已经发出、不宜自动重放，清理连接后抛出，让后续显式请求决定下一步。[发送与错误分支：S33、S34](https://jiuchenm.github.io/workbuddy-study/#S33)，其中[错误分类函数：S34](https://jiuchenm.github.io/workbuddy-study/#S34)限定了可处理的本地端点与错误类型。

区别在于能否排除业务已经开始。连接被拒绝通常说明目标端点没有接住请求；发出后断流则可能发生在任意阶段。应用没有收到结果，不代表对端没有执行。工作簿例子走到这里，已知输出只有连接错误，业务输出仍未知。合理的后续动作是先恢复连接、查询文件状态，再决定续接或重新执行；这是从未知结果边界推出的处理建议，不表示已验证产品自动完成了这套检查。

“重试一次”也有停止条件。第一次遇到本地端点不可用，Backend 重置后再发送；第二次失败时不会继续循环重发。如果第二次属于可恢复的 transport 错误，它也会标记 replay unsafe 后抛出；其余错误按相应分支抛出。这里所谓可恢复，表示可以清理通道、为后续请求准备条件，并不表示这一轮业务已经成功。

这个实现仍不是 exactly-once（恰好执行一次）保证。错误码只是在当前边界提供线索，不能证明外部业务事务的状态。若工具调用跨出本机，避免重复提交还可能需要业务 operationId、幂等键或状态查询；幂等键是在业务服务明确支持时，用来识别同一次操作、避免重复生效的标识。Agent 对话中的 requestId 主要用于关联请求，除非目标服务明确以它去重，否则不能直接充当业务幂等键。

配置更新走另一条规则。可见代码将 set_config_option 的部分 transport 故障也纳入重置后重试，因为把配置字段设成同一个值在这里被视为幂等，也就是再次设置不会增加一次业务动作。通用 extension 入口还承载入队、立即发送等动作，不能全部套用该策略。重试范围由操作语义决定，共用一个 HTTP 客户端不足以证明可以采用相同策略。[配置重试说明与分支：S56](https://jiuchenm.github.io/workbuddy-study/#S56)

一次假设时序可以检查这种差异：

```text
t0  设置 thought_level=high，连接重置
t1  重建连接后再次设置同一值：可采用配置重试分支
t2  发送“在工作簿新增汇总页”，结果流中断
t3  重建连接：只恢复通道，不能据此认定 t2 未执行
t4  查询已有产物/任务标识后，决定续接或重新执行
```

## 取消为什么也需要序号

取消操作不总能立即发出。promptSeq 是 Backend 记录的输入序号，每次进入 prompt 路径都会增加。代码中的 cancel 先记录当前 promptSeq，再 await ensureInitialized。假设用户想取消刚才的工作簿任务，但在初始化等待期间又提交了下一条 prompt，promptSeq 已经增加；这时旧 cancel 应该被跳过，否则它会误取消新请求。[取消保护：S32](https://jiuchenm.github.io/workbuddy-study/#S32)

epoch 和 promptSeq 解决的是两种问题。epoch 区分不同 runtime 代际，promptSeq 区分同一 backend 的请求进展。它们都不是业务文件版本。取消消息即使成功发出，也只是在要求停止执行，不能据此认定已落盘的汇总页被撤销。把全部标识合成一个 ID，会让“旧连接消息”“旧取消请求”“旧产物结果”难以分别判断。

分析故障时可以先记录四条信息：sessionId 指向哪段会话；runtime epoch 指向哪个执行实例；promptSeq/requestId 指向哪轮输入；业务对象 ID 指向哪个实际动作或产物。之后再检查连接错误发生在何处、已有何种后端活动、是否标记 replay unsafe、用户最终看到了什么。这样才能区分启动慢、会话失效、业务超时和重复执行风险。

<details>
<summary>面试怎么回答</summary>

一分钟回答：WorkBuddy 的预热池复用已经启动的 CLI，但先校验环境，再通过带身份检查的 ready ACK 激活。会话重连时，backend 用 epoch 和 active client 集合过滤旧回调，softReset 保留逻辑会话，destroy 才终结对象。请求重试又单独分类：本地端点拒连可重置重试，发送后未知状态则标记不宜自动重放。取消也比较 promptSeq，避免延迟取消落到新请求。连接恢复、请求重试和业务幂等必须分别设计。

追问一：为什么有 sessionId 还要 epoch？同一用户会话可以更换 runtime，旧 runtime 的晚到事件仍带同一 sessionId。epoch 表示当前哪一代实例有更新资格。

追问二：把重试次数设为一就安全了吗？不安全。即使只重复一次，扣款、发消息或新增文件也可能重复。必须先判断操作语义和是否已发生，次数只能限制放大程度。

追问三：ping 成功是否表示可以发送业务？不一定。进程可响应、协议已连接、会话已加载是不同阶段，应等待对应 ready 语义，并验证它属于预期进程和会话。

</details>

练习：一个 cancel 捕获 promptSeq=12，等待初始化期间用户发出新请求，序号变成13。同时，旧 runtime 的更新携带 epoch=4，而当前为5。两条消息分别应该怎样处理？这能否证明第12轮业务没有修改文件？

<details>
<summary>练习参考思路</summary>

cancel 比较序号后跳过，避免取消第13轮；旧 runtime 回调因 epoch 不匹配被忽略。这两项只限制之后谁能控制或更新会话，不撤销第12轮已经产生的文件修改。要判断业务结果，仍需读取产物或业务系统状态，并关联实际 operationId 或文件版本，不能从“旧消息被忽略”推出“动作没有发生”。

</details>
