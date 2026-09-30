# WorkBuddy：一次请求怎样穿过桌面、Daemon 与 CLI

WorkBuddy 是桌面 Agent 应用：用户在窗口提出任务，应用在后台准备会话，把任务交给 Agent 执行程序，再将进度和结果送回窗口。这篇要解释一次请求怎样经过这些层，以及为什么“窗口还在”不能说明后台仍在正常执行。

假设我们输入：“读取工作目录里的 `daily.md`，用一句话说明今天完成了什么、还有什么没完成，不修改文件。”文件写着“今天计划 10 项任务，完成 8 项；其余 2 项等待数据”，预期回答是“今天完成 8 项任务，另有 2 项因等待数据尚未完成”。如果页面显示几个字后报连接中断，仅说“模型回答失败”不足以定位：问题可能出在启动、提交或结果回传。文件、请求、回答与中断现场均为教学假设，没有实际运行 WorkBuddy。

先认识请求会经过的三个名字。**Daemon** 是应用后端服务，维护会话、配置和执行状态；**CLI（Command-Line Interface，命令行接口）** 在本文指实现 Agent 后端的命令行程序，由桌面应用启动或接入；**ACP（Agent Client Protocol，Agent 客户端协议）** 约定宿主与 Agent 如何加载会话、提交问题和交换更新。Daemon 维护工作所属的会话，CLI 承担 Agent 执行，ACP 帮两边说清消息的含义。ACP 与负责连接工具的 MCP 职责不同。[ACP 官方介绍](https://agentclientprotocol.com/overview/introduction)、[S48：执行进程管理](https://jiuchenm.github.io/workbuddy-study/#S48)、[S50：ACP 方法映射](https://jiuchenm.github.io/workbuddy-study/#S50)

实现依据是 2026-09-28 只读检查的 Windows 安装包 **5.6.2**；2026-10-01 改稿时重新核对了安装文件哈希及关键静态片段。`app.asar` 的 SHA-256 为 `c4304eec1f8849ea16b9492f02dcc5d1e93be4a7aed184b7effaabd2f06c9d22`。下文行号均相对于这个快照内的 entry。S 编号指向[公开证据定位目录](https://jiuchenm.github.io/workbuddy-study/#S01)，该目录没有公开完整源码，不能把目录说明当成独立复现，也不能从静态分支推出当前账号的实际运行路线。

如果还不熟悉主进程、renderer 与操作系统进程的区别，可先读 [Electron 与 Edge/Chromium 的进程管理](#/lesson/electron-chromium-processes)，再回到本篇跟踪具体调用。

## 窗口接到输入之后，谁继续工作

WorkBuddy 使用 Electron。Electron 的主进程（main process）管理应用入口、窗口和桌面能力；渲染进程（renderer process）运行页面，处理输入框、消息列表等界面。预加载脚本（preload script）在 renderer 内、页面加载前运行，通过桥接接口把限定的桌面能力交给页面。Preload 是脚本的职责与运行位置，不是第三种独立进程。[Electron 进程模型](https://www.electronjs.org/docs/latest/tutorial/process-model)

为什么不让输入框的代码直接承担全部任务？页面交互、桌面能力和 Agent 执行需要不同的权限与生命周期。界面收集“总结日报”这句话，后台还要知道工作目录、会话身份，以及怎样接入可持续工作的 CLI。分开职责后，窗口代码通过明确的接口请求后台能力；代价是每次跨进程都需要传递消息，连接和回调也可能失效。这是理解此架构的工程理由，不是对供应商设计动机或可靠性的实测结论。

以日报请求为例，窗口先要把操作交给有相应能力的后台。安装包的 Preload 检查消息来自当前窗口、类型匹配且带有 MessagePort，再用 `ipcRenderer.postMessage` 通过 Electron IPC（Inter-Process Communication，进程间通信）把端口交给 main。MessagePort 是两端互发消息的通道；这里转交的是通道，不是理解日报内容。对应入口是 `preload/index.js` 的 `installDaemonTransportPortForwarder`（L9954–9962）。同一 entry 的 `invokeDaemonFrame`（L9880–9894）展示了请求帧的 `id`、`type`、`channel`、`args`：调用有身份和路由，错误帧会抛错，成功帧则取出 `result`。[S45：Preload 传输入口](https://jiuchenm.github.io/workbuddy-study/#S45)

Main 随后按调用的路由转发到 Daemon。`main/index.js` 的 `dispatchWbInvoke` 分支（L7907–7926）调用 `daemonConnection.invoke`；其中 `wb:` 调用通过 `wb:invoke` 携带 `trustedContext`。这一步交接应用调用及其上下文，还没有让 CLI 读取 `daily.md`。这里重建的是可见入口的职责，没有捕获本例输入框的一次真实点击轨迹，不能据此声称每个页面只采用同一条桥接通道。[S47：Main 调用转发](https://jiuchenm.github.io/workbuddy-study/#S47)

Daemon 接手会话与执行状态，不过它不必在另一个操作系统进程中。`createDaemonTransport`（`main/index.js` L27657–27716）按模式选择 `in-main` 或 `stdio-fork`：前者在主进程中装配 Daemon，后者启动子进程并取得连接。**逻辑组件与操作系统进程并不一一对应。** Renderer 与 main 有进程边界；main 与 Daemon 是否跨进程，要看启动模式。只画固定的多进程链会漏掉代码中的另一分支。[S46：Daemon 两种承载方式](https://jiuchenm.github.io/workbuddy-study/#S46)

## 一个会话对象，怎样取得 CLI 执行环境

用户可以在同一个聊天中连续提问，所以应用需要比单次调用活得更久的会话对象。Backend 是连接应用会话与 Agent 执行环境的后端对象；client 是它用来与 Agent 通信的客户端对象。`CodeBuddyCodeBackend.create` 创建的 `CodeBuddyCodeSessionBackend` 保存会话 ID `sessionId`、工作目录 `cwd`、运行配置和 ACP client；创建时还检查同 ID 的旧 backend，解除遗留 client 的连接。这些状态说明“日报请求属于哪个聊天、在什么目录下继续”，不能证明模型此刻正在生成（`main/server.js` L174741–174883）。[S51：Backend 与会话对象](https://jiuchenm.github.io/workbuddy-study/#S51)

对假设请求来说，`cwd` 决定 `daily.md` 从哪个工作目录解释。`initializeInternal` 先解析 CLI 路径、组装环境与 MCP 配置，再准备系统提示词、提示变量和 MCP 配置的临时文件，构造带 `--serve`、`--session-id` 等参数的 runtime 请求。这里看到“准备了某个配置”只能确认交接行为，不能证明相关工具已经调用，也不能由目录中存在某个模板推断它一定成为最终提示词（`main/server.js` L174908–175048）。[S01：初始化与配置交接](https://jiuchenm.github.io/workbuddy-study/#S01)

Runtime 指这次会话使用的实际执行环境。准备好参数后，`acquireRuntime` 尝试取得已提前启动的预热进程并激活；未命中或激活失败时，回退到 `runtimeManager.createSession` 的冷启动路径。预热改变的是取得执行环境的方式，此时日报请求仍未提交。因此，预热失败还有冷启动这一条路，也不能仅凭代码分支估计省了多少时间（`main/server.js` L175221–175255）。[S02：取得 Runtime](https://jiuchenm.github.io/workbuddy-study/#S02)

Sidecar 则是陪同宿主运行的辅助进程。此安装包的 `SidecarManager` 管理长期运行的 Node.js sidecar，由它托管 CLI 后端的伪终端（PTY）会话，即让程序像连接终端一样收发输入输出。管理器通过 JSON-RPC 请求创建、终止或列出这些执行会话，并处理数据通道；JSON-RPC 是以 JSON 消息表达方法调用及结果的通信方式。`createSession` 还会查找同 ID 的现有会话，判断端点能否到达，再决定重连或创建（`main/code-cache.js` L68419–68431、L68643–68686）。Daemon 管应用层会话，sidecar 管执行进程及其通道，CLI 承担 Agent 后端；三者没有因为都在“后台”就合并成一个角色。[S48：Sidecar 生命周期](https://jiuchenm.github.io/workbuddy-study/#S48)

这份划分解释了一个常见现象：页面还在、会话对象还在，不代表 CLI 的端点仍可用；反过来，CLI 仍在执行，也不代表页面仍订阅着正确的输出。代价是系统要维护跨边界的身份和状态，不能只保存一条“正在处理”的布尔值。

## 连接、加载会话和提交问题是三步

取得 runtime 后，backend 得到通信地址 `acpEndpoint`，再创建 ACP client。到这里有了可连接的执行环境，但日报任务还要经过三个动作：连接端点、加载会话、提交问题。WorkBuddy 的可见 client 先向 `/connect` 发起连接并检查返回的 `connectionId`；方法表把 `loadSession` 映射成 `session/load`，把 `prompt` 映射成 `session/prompt`（`main/server.js` L173450–173501）。这些 HTTP 连接细节属于此安装包的实现，不是所有 ACP 实现必须采用的方式。[S50：ACP 连接与方法映射](https://jiuchenm.github.io/workbuddy-study/#S50)

连接成功后，`initializeInternal` 再加载或恢复会话。若请求种类是 `load`，它调用 `loadSession`；若是 `resume`，调用 `resumeSession`；其他初始化分支也会调用 `loadSession`，附带当前 `sessionId`、`cwd`、MCP server 列表与 `codebuddy.ai/continue: true`。因而不能看见新建 backend 对象，就断言后面必然发送 `session/new`。加载建立的是这次连接要使用的会话上下文；“已经 load 成功”还没有表示日报已被读取（`main/server.js` L175070–175108）。[S01：连接后的会话装配](https://jiuchenm.github.io/workbuddy-study/#S01)

真正提交问题时，应用会话管理器 `SessionManager` 取得日报请求所属的会话，解析本轮追踪信息，通过 `composePromptForBackend` 组装输入，标记开始处理，再调用 `backend.prompt`（`main/server.js` L93577–93658）。Backend 先确保初始化完成、检查提示变量文件，然后把输入连同 `sessionId` 交给 ACP connection。**会话加载成功和本轮问题已经提交是两个状态。** 前者不能证明 `daily.md` 已被读取。[S49：会话层提交](https://jiuchenm.github.io/workbuddy-study/#S49)、[S33：Backend 提交](https://jiuchenm.github.io/workbuddy-study/#S33)

以下 JSON 是帮助理解字段关系的教学示意，不是抓包，也省略了实际上下文与产品扩展字段：

```json
{
  "method": "session/prompt",
  "params": {
    "sessionId": "session-demo",
    "prompt": [
      {
        "type": "text",
        "text": "读取 daily.md，用一句话总结完成与未完成事项，不修改文件。"
      }
    ]
  }
}
```

此时 CLI 才拿到本轮需要处理的内容。若本例成功，后端还须取得文件内容，才能依据“8 项完成、2 项等待数据”回答；发送问题本身没有提供文件事实。模型如何选择读取工具、工具权限怎样判断，是后续[工具执行篇](#/lesson/workbuddy-tools)的范围。这里也没有把某次工具返回伪装成已观察到的运行结果。

## 回来的不只有最后一句话

长任务不能一直等到最后再返回一个字符串。WorkBuddy 为会话更新、工具提问、权限请求和结构化补充信息分别设置回调。`createWorkbuddyAgentAcpClient` 暴露了 `resolvePermission(requestId, optionId)`、`answerQuestion(toolCallId, answers)` 等接口；这意味着一次处理中可能需要用户作答，再把回答送回正确的等待项（`main/server.js` L174136–174185）。普通文本里出现“请确认”，与协议中出现待处理的权限请求，不能视为相同状态。[S44：ACP 回应接口](https://jiuchenm.github.io/workbuddy-study/#S44)

在假设的成功路径中，后端取得文件内容，CLI 随后分段输出“今天完成 8 项任务，另有 2 项因等待数据尚未完成”。文本块经 ACP client、backend 和应用会话层传回；`SessionManager` 的回调识别 `agent_message_chunk`，提取并累积文本，同时继续转发原有会话更新。工具事件有独立的类型和 `toolCallId`，最终 `prompt` 响应则是另一个完成信号。窗口可以陆续展示进展，但已显示几个字不能证明本轮完成，也不能证明答案符合文件事实（`main/server.js` L93618–93658）。这里跟踪到的是后端事件转发，没有抓取窗口每一次绘制的实测轨迹。[S49：消息块与工具事件](https://jiuchenm.github.io/workbuddy-study/#S49)

跨层事件需要关联正确的工作项，因此这里保留了几类 ID：

| 标识 | 关联什么 | 在日报例子中的作用 |
| --- | --- | --- |
| `sessionId` | 持续存在的会话 | 后续提问仍可属于同一个聊天 |
| `promptRequestId` | 一次提交的追踪记录 | 区分这次日报问题与后一次提问 |
| `connectionId` | ACP 传输连接 | 重连可以取得新 ID，聊天未必改变 |
| 权限回调的 `requestId` | 一个待批准请求 | 将用户的选择送回正确的等待项 |

这些 ID 可能在相邻日志行中出现，但生命周期不同。不能拿会话 ID 回答权限请求，也不能把新的连接 ID 当作用户必然新建了聊天。[S33：请求追踪](https://jiuchenm.github.io/workbuddy-study/#S33)、[S50：连接身份](https://jiuchenm.github.io/workbuddy-study/#S50)

还需要防止旧连接的迟到事件污染当前会话。`createClient` 内的 `isCurrentRuntime` 同时检查 runtime 的世代编号 `runtimeOwnershipEpoch` 与 client 是否仍在 `activeCallbackClients` 中；检查不通过，消息、权限请求等回调直接返回。世代编号相当于“这是第几次取得的运行实例”，不是用户请求编号。因为运行环境重建后 `sessionId` 可以不变，仅比较会话 ID 无法排除旧实例的消息（`main/server.js` L176002–176075）。[S31：事件所有权](https://jiuchenm.github.io/workbuddy-study/#S31)

## 失败后，先确认哪一段没有完成

回到开头的中断，应先问日报请求走到了哪里。如果 runtime 尚未取得，就没有可提交问题的 ACP 端点；如果连接失败，会话加载尚未完成；如果文本已经输出后连接断开，CLI 可能执行过部分工作。三者都表现为“没有完整回答”，可恢复性却不同。

Backend 的 `prompt` 对本地 ACP 端点不可用的特定分支最多自动重试一次。对连接重置、超时等发送后状态不明的传输错误，则标记 `after_send_or_unknown` 和重放不安全，重置状态供下一次明确提交使用，不直接再执行原问题。**恢复连接不等于可以安全重做任务。** 这是失败分支保留发送阶段信息的原因。[S33：提交失败处理](https://jiuchenm.github.io/workbuddy-study/#S33)、[S34：错误分类](https://jiuchenm.github.io/workbuddy-study/#S34)

本例只读日报，重复读取的后果较小，但相同链路也可能承载写文件等操作。没有收到成功响应，不能推出动作没有发生。要继续诊断，应将“会话已加载”“本轮已发出”“收到哪些更新”“最终响应是否到达”分别记录，而不是把它们压成一个成功标记。具体恢复条件留在[会话恢复篇](#/lesson/workbuddy-recovery)；本篇通过安装代码确认的是这些分支与责任位置，没有验证当前账号的配置、实际进程拓扑、耗时或示例执行结果。

<details>
<summary>面试怎么回答</summary>

**一分钟回答：** WorkBuddy 是桌面 Agent 应用。一次日报请求先由 Electron renderer 接收，通过 Preload 和 main 的桌面桥接交到 Daemon。Daemon 管应用层会话，backend 准备工作目录、环境和配置，再取得 CLI 执行环境；sidecar 管执行进程及通道的生命周期。宿主通过 ACP 与 Agent 通信，先连接、加载或恢复会话，再提交本轮 prompt。文件内容仍需执行层取得，文本块、工具事件和权限请求随后回传，最终响应才是另一项完成信号。main 与 Daemon 未必跨进程；会话、请求、连接也各有身份，运行环境重建后要过滤旧 client 的迟到事件。这些机制由 5.6.2 静态安装代码确认，实际路线和任务结果仍需运行证据。

**追问一：为什么不能每次发消息都创建一个新进程？** 可以这样设计，但会反复付出启动和会话加载成本，也更难维持已有上下文。这里保留会话对象并支持预热或重连，代价是必须判断旧执行环境是否仍有效、配置是否适用，以及回调还属于谁。是否值得复用要结合实际开销，不能从存在预热代码推出性能数字。

**追问二：已经有 sessionId，为什么还检查 runtime epoch？** 同一个聊天可能经历运行环境重建。旧 client 与新 client 都可能关联同一 sessionId，但旧实例不再有权更新当前状态。epoch 与 active client 检查约束事件来源，避免仅凭业务会话身份接纳迟到消息。

</details>

练习：假设 `session-demo` 的第一次 runtime 已断开，应用为同一会话建立了第二次 runtime。旧 client 随后送来一段“已完成”的文本，新 client 则还在等待权限答复。能否因为两者 `sessionId` 相同，就显示完成并清掉等待状态？若用户允许继续，应使用哪个标识关联答复？

<details>
<summary>练习参考思路</summary>

不能。应先验证事件来自当前 runtime 和仍有效的 client，旧来源的完成文本不能覆盖新实例状态。权限答复需要关联当前待处理权限请求的 `requestId`，并携带所选 `optionId`，不能用 `sessionId` 或本轮追踪 ID 替代。如果当前请求已经失效，也不能把旧答复套到后来出现的另一项请求上。

</details>
