# DeepSeek Harness 插件架构：Cordis 怎样组装一个 Agent

一个 Agent 已经能完成“请求模型→执行工具→回填结果”，为什么加一个工具还要理解插件框架？设想你在启动函数里直接创建模型客户端、工具表和会话日志，再为它们绑定监听器。程序首次运行可能正常，切换模型后却留下旧监听器，重新加载配置又注册了两遍工具。问题出在能力之间怎样连接、谁拥有资源、退出时谁负责释放。Cordis 管理的就是这些关系。先修是 [项目定位](#/lesson/deepseek-harness-intro)和 [Agent 循环](#/lesson/deepseek-harness-loop)。

本文核验于 2026-10-03，源码固定在发布版 [`477b4f4`](https://github.com/deepseek-ai/deepseek-harness/tree/477b4f420553e8a52c2fbccc464d7561b239c443)，包版本为 `0.1.7-rc.2`。旁边开发检出 `da00f7f` 的 CLI 是 `0.2.0-rc.2`，本文不混用两版行为。以下例子按源码手推，未运行模型请求或安全测试。

## 先确定 Cordis 管什么

Cordis 是进程内插件框架。插件贡献服务、事件处理器和资源注册；Harness 的模型适配器、工具注册表、会话存储和 Agent loop 都可以由插件提供。Cordis 不负责预测下一个 token，也不承担跨机器任务调度。模型推理属于模型服务，分布式执行需要另外的协议与基础设施。[架构文档](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/docs/architecture.md)中的“全部由插件组成”说明装配方式，不能据此推导性能、容错或安全保证。

上下文（Context）是服务容器，也承载插件所属的范围。这里的 context 与 LLM 的上下文窗口含义不同：前者让代码找到 `ctx.tools`、`ctx.llm`，后者是模型输入的消息与 token。插件可以是函数、带 `apply(ctx, config)` 的对象，或类；提供一个服务是把具体实现注册到名字下。使用者声明 `inject` 依赖，随后通过名字调用实现，这就是依赖注入（Dependency Injection）。它省去了使用者对具体实现的硬编码导入，并让框架知道什么时候可以启动使用者。[Context 与 Service 源码](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/vendor/cordis/src/context.ts)。

| 要解决的问题 | 原语 | 在 Agent 中的用途 |
|---|---|---|
| 代码怎样找到能力 | 服务注册与 `inject` | loop 找到模型和工具服务 |
| 怎样插入处理步骤 | 事件与 `next()` | 在请求或工具执行处拦截 |
| 配置怎样限定影响范围 | 子 Context 与 `isolate` | 一组插件使用另一份服务 |
| 卸载后怎样释放注册 | `effect` 与 disposer | 移除监听器、工具和连接 |

声明依赖具有运行时意义。必需服务缺失时，插件不会执行主体；服务出现后才激活。提供者被替换或卸载时，依赖它的插件需要随之重新调整生命周期。源码用 Fiber 跟踪这些状态；这里的 Fiber 是插件实例的生命周期记录，不是操作系统线程。[依赖刷新与加载代码](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/vendor/cordis/src/fiber.ts#L609)。

## 从配置走到一次调用

启动时，`app-boot` 创建根 Context，安装 Loader，挂载配置树并等待状态稳定；必需条目失败与可选条目失败有不同处理，不能把“进程已启动”视为所有能力都可用。[boot 实现](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/boot/app-boot/src/index.ts#L972)。

配置分成几层。profile 是一种命名的应用组合，例如 `web` 或 `sdk`，它列出要叠加的 bundle；bundle 携带插件代码及配置 patch；patch 根据条目 ID 修改或插入插件。启动不是先造一个固定应用再修改，而是从空条目列表开始按顺序组合：

```mermaid
flowchart LR
  A[profile 中依次列出的 bundles] --> B[profile 的 cordis.patch.yml]
  B --> C[home 的 cordis.patch.yml]
  C --> D[命令行 --patch overlays]
  D --> E[Loader 挂载插件树]
  E --> F[依赖可用后执行插件]
```

同一行的后层配置优先，但 `config` 是整个对象替换，不能当成递归合并：保留字段也要重写。这既允许换掉一组能力，也会造成漏写字段后回到默认值的配置错误。[组合顺序与 patch 源码](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/boot/app-boot/src/profile-context.ts)、[字段覆盖实现](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/vendor/include/src/index.ts#L117)。

下面只演示装配与调用，`calc`、`demo/compute` 是假设的名字；伪代码省略 TypeScript 类型声明和 Loader 配置，不可直接粘贴运行。

```text
1  DoubleProvider.apply(ctx):
2    ctx.provide("calc", { double: n => 2 * n })
3  AddOne.inject = ["calc"]
4  AddOne.apply(ctx):
5    ctx.on("demo/compute", (n, next) => ctx.calc.double(next()) + 1)
6  mount(AddOne)
7  mount(DoubleProvider); await activationTasks()
8  output = ctx.waterfall("demo/compute", 3, () => 3)
```

第 1 行定义提供者的启动主体，第 2 行把翻倍函数注册成 `calc` 服务。第 3 行声明使用者必须等到 `calc` 可用，第 4、5 行才会运行并注册监听器。第 6 行先挂载使用者时，它会等待；第 7 行挂载提供者，并等待示意的激活任务稳定，使用者才能完成注册。第 8 行输入为 3，末尾回调返回 3；监听器调用 `next()` 获得 3，通过服务算出 6，再加 1，最终输出 7。这是手算结果。

这里的 waterfall 是环绕式中间件（around middleware）：每个监听器拿到原始参数和 `next`，调用 `next()` 才进入下一层，返回时可以包装结果。它不是自动把上一个返回值作为下一个输入。监听器不调用 `next()` 就会截断后续监听器及最终行为，所以一个只想记录日志的插件也可能误阻断执行。[waterfall 的实际实现](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/vendor/cordis/src/events.ts#L232)。

事件还有不同调度方式：`emit` 不等待监听器的 Promise；`parallel` 等待并行监听器；`serial` 逐个等待并可提前停止；`bail` 同步寻找第一个停止值。`waterfall` 本身也不自动等待各层，但返回链可以携带 Promise。该用哪种由事件约定决定，不能看到“事件”就当作消息队列，或以为所有监听器都串行完成。[事件入门与调度表](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/docs/cordis-primer.md)。

## 插件树与资源寿命

插件树表达父子挂载关系和资源归属，不等于每个节点都有独立进程。子 Context 可以继承父 Context 的服务范围；访问仍受已声明的依赖与当前激活状态约束。`isolate("tools")` 为 `tools` 建立另一个查找标签，使该分支可以使用不同实现。Loader 中 `isolate: { tools: true }` 创建条目自己的范围，字符串标签则让指定条目共享命名范围。其他没有隔离的服务仍沿原来的范围解析。[Context 隔离](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/vendor/cordis/src/context.ts#L120)、[Loader 范围映射](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/vendor/loader/src/config/isolate.ts)。

代价是“名字相同”不保证“实例相同”：提供者在范围 A、使用者在范围 B，即便都写 `tools`，依赖也可能无法满足。排查时要同时看名字、范围、依赖和激活状态。这个隔离只控制服务可见性，不隔离内存、文件或网络；同进程可信插件仍是普通 JavaScript 代码，Cordis 没有由此建立 kernel 或 VM 沙箱。

注册本身也需要寿命。副作用注册（effect）是框架能追踪的资源建立过程，释放函数（disposer）负责清理资源。`ctx.provide()` 和 `ctx.on()` 已把服务或监听器纳入所属 Fiber；插件卸载时框架移除它们。自建定时器、连接或其他资源，则应由 `ctx.effect()` 返回对应清理函数。例如建立一个 timer 后返回 `clearInterval(timer)` 的闭包，释放的是以后继续触发的机会，不会撤销 timer 已执行的工作。[effect 实现](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/vendor/cordis/src/fiber.ts#L418)。

同一 effect 收集的清理函数按逆序释放；不同 effect 的卸载不能随意假设串行顺序。连接必须先停止请求再关闭 transport 时，应把相关清理放进一个有明确顺序的 effect。遗漏 disposer 会留下旧监听器或连接，清理顺序错误则可能打断仍在执行的任务。

热模块替换（Hot Module Replacement，HMR）利用这套寿命管理卸载旧插件、重建新插件。发布版 base 默认启用仅配置监视，headless、SDK、ACP 默认禁用；源码监视需要另配。模块替换失败时，代码有恢复缓存并重新注册旧插件的路径。但这类恢复只涉及加载状态，不会撤回已写入的文件、已发送的网络请求或已完成的外部交易。外部副作用需要应用自己设计幂等、补偿或事务。[DSH HMR](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/boot/hmr/README.md)、[缓存恢复代码](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/vendor/hmr/src/index.ts#L383)。

## MCP 接在什么位置

内部 Cordis 插件可以直接提供服务或注册事件；MCP server 则通过协议对外提供工具和资源。Harness 的 `mcp-client` 本身是 Cordis 插件：建立连接，发现工具，将 schema 注册到 `ctx.tools`，执行时转成 MCP `tools/call`，再把结果带回 Agent 循环。外部服务器不会被挂成内部 Context 节点。[工具桥接源码](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/mcp/mcp-client/src/tools.ts#L113)。

```text
Agent loop → ctx.tools → 内部 mcp-client 插件 → MCP transport → 外部 server
                    ← 结果回填             ← tools/call 结果
```

服务器名与工具名共同形成模型可见名字，如 `mcp__docs__search`，避免两个服务器都叫 `search` 时冲突。连接和工具注册由插件生命周期管理，服务器断连、发现失败和调用超时则是新增的故障来源。[MCP 客户端说明](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/mcp/mcp-client/README.md)。

模型经 `ctx.tools` 发起的调用可以进入对应工具处理路径，但插件任意内部行为并不会自动通过工具权限检查。特别是这版 MCP stdio 由 SDK 启动子进程，transport 复用环境变量清理函数，却没有经过 `ctx.sandbox` 的启动路径。清理环境变量与限制进程权限是两种保障，不能混为一谈。[transport 源码](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/mcp/mcp-client/src/transport.ts)。

## 可组合性的代价

模块可替换后，复杂性转移到了依赖图、配置优先级、事件顺序和资源寿命。先用 `dsh --profile web --dump-config` 查看合成条目，再核查实际激活状态，有助于区分配置错误与运行时失败。dump 会保留 `!!js` 表达式，不证明表达式求值成功或服务器可达；收集配置 schema 又可能执行模块导入、Config getter 与 lazy builder，所以预览也不是运行不可信插件的安全边界。[app-boot 的预览与 schema 说明](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/boot/app-boot/README.md#previewing-the-effective-configuration)。

项目处于 developer preview，公开 API 仍可能发生破坏性变化。启动器检查插件声明的 DSH `peerDependencies` 是否兼容当前 runtime，但未声明 peer 就不产生该项约束；兼容检查也不验证插件安全性。教学示意因此必须和可安装版本分开。[预览状态](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/README.md#developer-preview)、[兼容检查](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/boot/app-boot/src/plugin-compatibility.ts)。接下来读 [长任务、上下文与权限边界](#/lesson/deepseek-harness-state-security)，进一步区分插件资源、会话状态和执行权限。

<details>
<summary>面试怎么回答</summary>

约一分钟的回答：Cordis 是 DeepSeek Harness 的进程内装配框架。插件通过 Context 提供服务，使用者声明 inject 依赖；依赖可用才启动。事件支持观察或拦截，waterfall 用 next 控制是否继续。插件树和 isolate 控制服务范围，effect 与 disposer 负责卸载时释放注册和连接。profile、bundle、patch 决定启动组合，HMR 可以重建插件。它不提供模型推理、分布式调度或操作系统隔离；卸载也不自动撤销外部副作用。MCP client 是内部桥接插件，外部 server 通过协议连接。

**追问一：为什么不能用 import 代替 inject？**

import 能找到代码，却没有表达运行时服务实例是否就绪、属于哪个范围、何时被替换。inject 把这些依赖交给生命周期系统；普通工具函数仍可以直接 import。

**追问二：拦截器只打日志却忘了 next，会怎样？**

waterfall 链在这里结束，后续监听器和最终行为不执行。若只需观察，应遵守事件的观察约定；环绕处理则必须明确继续、截断和返回值。

**追问三：热重载失败并恢复旧插件，是否可以重试外部写入？**

不能直接推断。缓存恢复没有证明此前请求未成功，重试前需要查询结果或使用幂等键，否则可能重复写入。

</details>

练习：上例输出为 7。现在把第 5 行改成 `(n, next) => 10`，再把 `calc` 提供者放入使用者不可见的范围。分别判断：最终输出是什么？监听器还能注册吗？最后说明卸载插件能否撤销此前的文件写入。

<details>
<summary>参考思路</summary>

只改第 5 行时，依赖满足，监听器注册，但不调用 next，输出是 10。再隔离提供者且没有另一个可见 calc 时，使用者的必需依赖不满足，主体不运行，监听器没有注册；若独立执行第 8 行，它走最终回调，输出 3。卸载只运行已登记的清理过程，撤销文件写入需要额外设计，不能由 effect 自动推导。

</details>
