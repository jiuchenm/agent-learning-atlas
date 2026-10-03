# DeepSeek Harness 长任务：上下文、子 Agent 与权限边界

假设一个 Agent 已读过十几个源码文件，又让两个子 Agent 分别检查测试和配置。此时关闭终端，再打开 Session：历史还能显示，模型却未必逐字看见原来的文件内容；后台任务也未必继续运行。若先前工具已经改了文件，取消 Agent 更不会把文件恢复。这几个现象分别由持久存储、请求上下文、任务生命周期和权限系统决定。

本文核验日期为 2026-10-03，依据发布版 `0.1.7-rc.2` 对应的固定 commit `477b4f420553e8a52c2fbccc464d7561b239c443`。旁边 master checkout 的 `0.2.0-rc.2` 不代表本机安装版。本轮运行验证仅覆盖 CLI、Web 中文界面和 Read Only 选择，未配置 API key，也未完成真实模型、compact 或子 Agent 任务。以下机制来自固定版本源码；示例是推演，部署方案标为设计建议。

## 日志保存经历，上下文决定这一轮能用什么

Session 是一次会话的状态容器。事件日志（event log）按序追加用户输入、模型输出、工具结果、权限变化和生命周期事件。序号让恢复程序确定发生顺序。但日志里既有会产生模型消息的事件，也有只用于审计和运行管理的事件，完整日志不能直接等同于下一次 API 请求。

源码中的 surface 是当前产生模型消息的有序视图。它引用日志事件，解释追加或替换操作，再导出消息。压缩改变 surface，却不删除原事件。另一个名字相近的 session-projection 是状态投影：对已提交事件执行同步 fold，得到 todo、统计、子 Agent 列表等完整状态，向客户端返回 `asOfSeq`，说明快照反映到哪个事件。它服务于界面和宿主状态，不是摘要模型，也不是模型记忆。[surface 实现](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/core/session/src/surface.ts)、[状态投影契约](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/session/session-projection/README.md)

| 状态 | 内容与用途 | 恢复时的边界 |
| --- | --- | --- |
| 持久事件日志 | 执行记录及派生状态的依据 | 已落盘事件可重读，未完成动作未必有结果 |
| surface 与请求 | 当前消息，加上工具和运行信息 | 模型只获得这次请求携带的内容 |
| projection/checkpoint | 加快界面和宿主状态重建 | 派生值不代替外部系统现状 |
| 内存中的 Agent、job | 执行循环、等待与输出缓冲 | 保存会话不等于保存活跃进程 |

`session-persistence-jsonl` 为每个 Session 存追加日志，默认物理编码是带校验的 Zstandard 帧，`compression: none` 才是普通文本行。这里的压缩是存储压缩，和语义摘要不同。首批追加发布 header 与事件，后续批次追加后 `fsync`；底层 append 完成表示该批已经同步，而 live event 还有 write-behind 批处理，内存刚出现的事件不必然已落盘。崩溃恢复保留已提交前缀，处理损坏尾部，并补齐中断轮次的关闭记录。完整帧的校验或结构损坏会报 corruption，不能当普通尾部丢掉。[持久化与崩溃语义](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/session/session-persistence-jsonl/README.md)

恢复首先重建程序记录的经历，还需要重读外部事实。远端请求可能已成功，进程却在记录结果前退出；缺少成功事件不能证明没有生效。该版本源码的 `SESSION_FORMAT_VERSION` 是 `4`，不能从 README 历史目录示意推断当前逻辑格式。[格式常量](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/core/session/src/types.ts)

## compact 如何让下一轮继续

上下文压缩（compaction）解决请求越来越长的问题。`compaction-basic` 先测量压力，必要时调用工具结果裁剪器，再选择可压缩区间，请求 LLM 写摘要，检查摘要确实更小，最后追加摘要及 surface 替换记录。系统消息头不进入所选区间，边界不能拆开同一步中的 tool call/result 配对，否则下一轮可能只看到回答，却没有对应调用。[压缩策略](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/compaction/compaction-basic/README.md)、[区间及提交实现](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/compaction/compaction-basic/src/region.ts)

触发点不只是窗口的 80%。默认阈值为 `floor(min(W × 0.8, W − O − B))`：`W` 是模型上下文窗口，`O` 是预留输出额度，`B` 是额外 headroom，默认 `65536` tokens。假设 `W=131072`、`O=8192`，采用默认 headroom，阈值是 `min(104857.6, 57344)` 向下取整，即 `57344`。小窗口必须调整 headroom；工具 schema、运行信息等也会影响请求压力。

再假设测量得到 60000 tokens，可平衡替换的旧区间占 35000，其他内容占 25000。摘要占 3000，下一轮估计变为 `25000+3000=28000`，少了 32000。这是教学手算；实际选择还受近期保留量和配对约束，不能任意截取 35000。摘要应保留目标、已确认事实、标识、失败和下一步；遗漏细节的代价是重读来源，甚至误解约束。

工具裁剪器则按 Unicode code point 计数，超预算时保留文本头尾，用标记替换中间，非文本 block 保持顺序。它不调用摘要模型，也不知道关键错误是否位于中间。计算确定、成本较低，但语义损失更直接。它也追加替换事件，原结果仍在日志中。[裁剪实现](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/compaction/compaction-tool-result-pruner/src/index.ts)

compact 没有更新模型参数，因此不是训练；JSONL 没有保存 attention KV tensors，因此不是 KV cache 持久化。摘要调用可能复用提供商缓存中的相同请求前缀，但不意味着关闭本地程序后能恢复推理缓存。保存摘要的意义是以后重新构造较短文本输入。

## 子 Agent 分担上下文，仍共享运行环境

子 Agent 是另一个 Agent 实例，有自己的 Session id、事件流、结果与终止原因。`spawn-in-process` 从空上下文开始，把委派 prompt 当作任务输入；`fork-in-process` 复制父日志直到最后一个 `turn/end`，避开当前还未配平的工具轮次。fork 捕获的是创建时的前缀，不是与父 Session 自动同步的实时分支。[spawn 实现](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/subagent/subagent-spawn-in-process/src/index.ts)、[fork 实现](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/subagent/subagent-fork-in-process/src/index.ts)

| 委派方式 | 输入与结果路径 | 主要代价 |
| --- | --- | --- |
| fresh spawn | 明确 prompt，完成后返回子结果 | 少带历史，但要补齐背景 |
| fork | 继承已完成轮次前缀，再执行新 prompt | 复制背景，也复制无关内容和敏感信息 |
| one-shot background | 父级 job 返回 id，再读取或取消 | 并发占用与输出保留受 job 机制约束 |
| continuable | 持久子 Session，可继续发消息或冷恢复 | 管理 inbox、归属、通知与恢复状态 |

in-process driver 通过父 `ctx.agents.create()` 创建子实例，沿用父 cwd，组合父服务与工具范围，可添加 persona、`toolFilter` 和深度限制。它不是为每个子 Agent 启动 OS 进程或容器。工具过滤缩小可调用集合，但不把共享内存、宿主插件或文件系统变成安全隔离区。[创建与取消](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/subagent/subagent-in-process-driver/src/index.ts)、[子环境组合](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/subagent/subagent/src/child-agent.ts)

委派时捕获父级 sandbox override；审批服务存在时，子审批固定为 `never`，需要审批的操作直接拒绝。父后来扩权不会自动改变已启动的子任务；一次性批准也不是可继承通行证。Full access 或 Auto 身份在相应 in-process 路径中有继承处理，不能由“子 Agent”推断权限天然更低。ACP、Codex 等外部后端有自己的权限系统，不能套用这些进程内结论。

例如只检查三个函数签名时，fresh spawn 携带文件定位、问题与输出约束，通常比复制整个历史更合适；父仍要核验返回结论。并发可能减少等待，但增加模型调用、重复读取和整合成本。`jobs-local` 的 registry 与输出 ring 在内存中，owner 或 Harness 退出会取消任务；持久子 Session 可恢复，不等于旧运行现场和后台进程自动复活。[委派工具](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/subagent/tool-subagent/README.md)、[本地 jobs](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/jobs/jobs-local/src/index.ts)

取消是传递停止信号。日志后端能回退一次失败文件追加的长度，却不回滚工具此前改过的文件或外部 API 副作用。设计建议是对可能重试的外部写入使用幂等标识、结果读回和补偿操作，恢复时先核对目标状态。

## 审批和 sandbox 分别约束什么

工具审批回答“这一次敏感动作是否获准”。`ask` 交给已配置的 answerer，缺失或失败时 fail closed；`never` 自动拒绝需要审批的请求，不是自动批准。批准仅适用于这一次请求。OS sandbox 回答“执行时哪些文件操作会被内核或访问控制拒绝”。获准执行不等于一定成功，也不使 sandbox 限制消失。[审批契约](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/interaction/user-approval/README.md)

DSH 的 `SandboxMode` 只定义文件副作用。`read-only` 请求拒绝写入；`workspace-write` 允许 workspace 与后端规定的 temp；`danger-full-access` 绕过 confinement。网络和进程可见性不属于其保障。Linux 本地后端提供 bwrap/Landlock，macOS 提供 Seatbelt，Windows 提供 ACL restricted token；可用性与 enforcement 由后端报告。当前 bwrap profile 没有关闭网络 namespace，Seatbelt profile 也围绕文件写入设置。[sandbox 子系统](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/docs/subsystems/sandbox.md)、[平台 profile](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/sandbox/sandbox-local/src/profiles.ts)

Windows 用 `CreateRestrictedToken` 的 `WRITE_RESTRICTED` 约束写访问，再以 capability SID、允许 ACE、父目录删除权限的 deny 和 Low integrity label 组合写根。`workspace-write` 分别授予 workspace 与本 Session 私有 temp；`read-only` 不携带这两种写 SID，不授予显式写根。切回 read-only 后，之前留下的 workspace grant 不能仅凭自身通过 restricted token 写检查。

| Windows 控制 | 保障与限制 |
| --- | --- |
| restricted token + ACL | 约束相应写入与删除，初始化失败不能静默无沙箱执行 |
| workspace/temp grant | standing workspace ACL 与 Low label 留作复用；temp grant 可撤销，清理可能失败 |
| `partial` enforcement | hard link 是同一文件对象的别名，存在边界；读取未全面限制，某些 AppContainer ACL 文件反而不可读 |
| 网络与宿主插件 | 此后端不禁网络；宿主插件不因 shell 子进程受限而自动受同等约束 |

这些是明确报告的 partial，不能把 UI 的 Read Only 字样解释成整台机器的完整只读隔离。MCP 也要单独看：当前 stdio transport 由 MCP SDK 创建进程，仅复用父环境变量清洗，未调用 `ctx.sandbox`；Streamable HTTP 面向远端服务。工具通过审批，不等于 MCP 服务自身被 shell sandbox 包住。[Windows 后端](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/sandbox/sandbox-windows-acl/README.md)、[grant 生命周期](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/sandbox/sandbox-windows-acl/src/grant.ts)、[MCP transport](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/mcp/mcp-client/src/transport.ts)

## 保存与上传是两件事

官方 `session-log-deepseek` 默认 `enabled: true`，在官方 DeepSeek 请求旁携带 `dsh_session_log`，按已接受 watermark 上传连续事件后缀。字段不进入模型 `messages`，但仍把日志发出。HTTP 2xx 后记录 acceptance，崩溃可能造成重传；2xx 不证明模型已完成回答。compact 留下的原事件仍可能属于上传日志，不能把上下文变短当作数据删除。[上传契约](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/session/session-log-deepseek/README.md)

OTel 是独立路径，默认 `FEEDBACK_ONLY`：新反馈授权截至该事件的未发送前缀，可包含消息、工具参数、结果、summary 和 cwd，不只是评分。`DISABLED` 不建立 SDK 导出管道。撤回反馈导出删除事件，不承诺远端擦除；本地记录成功也不是 collector 收件回执。[OTel 说明](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/session/session-telemetry-otel/README.md)

本机初始 Web patch 分别将官方日志插件设为 `enabled: false`、OTel 设为 `DISABLED`，会话为 read-only/ask。这说明配置意图；本轮没有通过真实请求、抓包或 ACL 实验验证全部后台边界。企业部署的设计建议是为每个租户配置独立运行环境和凭据，限制出口网络，审查插件与 MCP server，设置日志保留和脱敏规则，把扩权限定到具体操作。扩大访问范围会扩大敏感输入、副作用及审计成本，多 Agent 数量不会替代这些控制。官方将项目标为未完成安全审计的 developer preview。[Safety](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/SAFETY.md)

本篇讨论 DSH 本地长任务。训练任务执行的 [DSec](#/lesson/dsec) fleet 是另一套基础设施，不能把它的吞吐、恢复和隔离主张迁移为 DSH 已有能力。通用原理见 [上下文压缩](#/lesson/compact)，请求路径见 [Agent 执行循环](#/lesson/deepseek-harness-loop)，服务组装见 [Cordis 插件架构](#/lesson/deepseek-harness-plugins)。

<details>
<summary>面试怎么回答</summary>

约一分钟回答：长任务需要分清四层状态：事件日志保存经历，surface 生成当前模型消息，compact 用摘要替换旧消息视图，Agent/job 管理活跃执行。子 Agent 有独立 Session，但 in-process 实现仍共享进程和目录，委派不构成安全隔离。审批决定某次动作是否获准，OS sandbox 执行具体限制；DSH 文件模式不保证禁网络，Windows 明确是 partial。恢复和取消不自动回滚外部副作用，应核对真实结果，再决定重试或补偿。

**追问一：既然日志完整，为什么模型会忘记？**

日志是恢复依据，模型只看本轮请求。摘要或裁剪改变输入视图，信息仍在磁盘却可能没送给模型。需要时重读精确来源，不能用“已保存”证明“正在上下文中”。

**追问二：父 Agent 是 ask，子 Agent 可以继续申请扩权吗？**

这版 in-process 路径在创建时固定子审批为 never，需要审批的动作会拒绝。作用域内可做的事仍可运行；超出范围应由父按适用权限处理，不能反复申请，也不能把 never 理解成免审批。

**追问三：read-only 是否防止秘密上传？**

不能据此推出。它约束文件写入，Windows 没有全面限制读取和网络；日志上传、OTel、MCP 和插件各有路径。需要独立的凭据、读取范围和出口策略。

</details>

小练习：假设父 Session 压力为 60000 tokens，compact 后为 28000；一个 fork 子 Agent 已开始读配置，另一个后台 job 向远端写入后没有返回结果，随后进程崩溃。重启后看到旧日志且 UI 显示 Read Only。哪些状态可恢复，哪些必须重新核实？怎样避免重复远端写入？

<details>
<summary>参考思路</summary>

从已落盘日志重建 surface、摘要和投影；fork 子 Session 有独立持久记录，不自动吸收父后续历史。内存 job 和运行现场不因日志恢复而继续。先检查哪些事件已提交、子任务是否结束，再核对远端实际状态；使用幂等标识时可据其查询结果再决定重试。Read Only 只说明当前模式选择，需要核验各执行路径和 Windows partial 边界，不能证明先前没有写入或当前禁止网络。

</details>
