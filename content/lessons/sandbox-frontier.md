# Agent Sandbox 技术报告：从操作系统隔离到大规模调度

一个 Agent 能执行 Python，能启动浏览器，还能在等待模型回复时保留文件与进程。把它放进 Docker，究竟隔离了什么？换成 microVM，哪些调用路径改变了？为什么训练系统能保留大量环境，却不需要给每个环境长期独占几颗 CPU？这些问题都要回到操作系统、状态和调度来回答。

本文面向会编程、但尚未系统学习虚拟化和资源管控的读者。先建立执行模型，再看 OpenAI、Anthropic、DeepSeek DSec、Xiaomi MiMo、Meta Muse 和国内云端助手公开到了哪一层。技术资料核验日为 **2026-10-01**；厂商描述来自本轮分工核验的一手文档、论文和源码，实验结果保留原作者归因，本文没有运行这些系统或复现安全与性能测试。教学假设会明确标记。

## 1. Sandbox 的本质：五项职责组成一个执行环境

Sandbox（沙箱）是受控执行环境：让一段不完全可信的程序运行，同时明确它能看见什么、能操作什么、能消耗多少资源、何时停止，以及由谁分配执行成本。“不完全可信”包括模型生成错误代码、恶意输入诱导的工具调用，也包括普通程序的无限循环、内存泄漏和错误重试。

“沙箱”这个名字没有指定唯一实现。一个进程、一组容器、一台 VM（Virtual Machine，虚拟机）或一个 WebAssembly 模块，都可能是某种沙箱的运行单元。需要分别问五个问题：

| 职责 | 实际问题 | 典型执行者 |
| --- | --- | --- |
| 隔离 | 程序看见哪些进程、目录、网络和内核？ | Linux namespaces、用户态系统接口、虚拟机、语言 runtime |
| 强制访问控制 | 可见对象中，哪些可读、可写、可连接？ | 文件权限、capabilities、seccomp、LSM、出口代理 |
| 资源限制 | 无限循环、内存膨胀、进程繁殖会怎样？ | cgroups、runtime 限额、超时控制器 |
| 生命周期 | 创建、执行、暂停、恢复、销毁各保存什么？ | 环境管理器、镜像与快照系统、进程树管理 |
| 调度 | 请求放在哪里，何时分配算力，过载如何处理？ | 队列、集群调度器、本地准入器、内核 CPU 调度器 |

这五项可以组合，不能互相代替。目录只读不会限制 CPU；独立 VM 不会自动识别一次 HTTP 请求是否经过用户授权；队列公平也不会修补内核漏洞。Docker 官方安全说明同样分别讨论 namespaces、cgroups、daemon 攻击面与内核安全机制。[Docker 安全机制](https://docs.docker.com/engine/security/)

还要区分两种边界：**控制面** 接收创建、停止、授权、配额变更等管理请求；**数据面** 实际执行命令、读写文件和传输数据。Agent 即使待在隔离良好的容器中，只要能调用高权限管理接口，仍可能越过预期权限。挂载 Docker socket 就属于这种问题：只读挂载约束挂载点的文件操作，没有把 socket 协议里的“启动特权容器”变成只读操作。

## 2. 从一条 Python 指令追到内核

进程是操作系统管理中的运行实例，拥有地址空间、身份凭据、打开的文件描述符等状态；线程是其中被安排到 CPU 上执行的单元。用户程序主要在用户态运行，内核态负责受保护的内存、设备、文件系统和网络等资源。程序需要这些服务时，发起 system call（系统调用，简称 syscall）。

下面的代码仅用于说明调用链，没有在本轮执行：

```python
with open("/workspace/result.txt", "w") as f:
    f.write("ok\n")
```

Python 的 `open` 最终需要操作系统打开文件，Linux 中可能经过 `openat` 等 syscall。内核解释文件路径、检查凭据与访问规则，成功后返回 file descriptor（文件描述符，简称 FD），它是进程中引用已打开对象的整数。写入流程通过 `write` 等 syscall 使用这个 FD，具体调用时机还受 Python 缓冲影响。代码没有 `sudo`，不能据此推断安全；真正决定结果的是执行进程的身份、挂载视图、内核规则和可调用接口。

一个程序如果只反复做整数运算，可能长时间不需要文件或网络 syscall，但照样占满 CPU。因此 syscall 限制与 CPU 限制必须分别部署。程序创建进程、申请内存、连接网络时，又触及不同资源。Linux 沙箱通常给进程建立受限资源视图，并让内核在请求到来时执行限制。[namespaces 概览](https://man7.org/linux/man-pages/man7/namespaces.7.html)、[cgroup v2](https://docs.kernel.org/admin-guide/cgroup-v2.html)

由此，选型问题可以变得具体：不可信程序的 syscall 由哪一个内核或系统接口实现处理？它能触及多大的接口面？处理请求的那一层又受谁约束？

## 3. Linux 原语分别改变了什么

### 资源视图与资源额度

**Namespace（命名空间）** 让同一内核为不同进程提供不同资源视图。mount namespace 决定看到哪套挂载；PID namespace 改变进程编号与可见进程；network namespace 提供独立的接口、路由等网络对象；user namespace 建立内外用户 ID 映射。容器里的 UID 0 可以映射成外侧非特权用户，但取决于实际配置，不能见到“容器 root”就推断其宿主身份。[Linux namespaces](https://man7.org/linux/man-pages/man7/namespaces.7.html)

Namespace 的对象是“看见哪套资源”，不会给程序创建另一份内核，也不自动提供完整访问策略。把 `/workspace` 放进独立挂载视图后，仍要决定哪些目录只读、哪些可写，是否暴露设备或 socket。网络空间也不等于完全断网：Docker 的 `none` 网络仍保留 loopback（回环接口），只是没有外网接口。[Docker none 网络](https://docs.docker.com/engine/network/drivers/none/)

**Cgroup（control group，控制组）** 把进程归入资源管理层级，内核按组计量、分配或限制 CPU、内存与进程数量。下面是 cgroup v2 接口的教学值，不是可直接运行的完整部署配置：

```text
cpu.max       = 200000 100000
memory.max    = 1073741824
pids.max      = 128
```

`cpu.max` 的两个值是 quota（额度）与 period（周期），单位均为微秒。每个 100,000 微秒周期，这组进程可累计使用 200,000 微秒 CPU 时间，等价于最多约两个 CPU 的时间预算；它没有承诺绑在两颗指定核心上。四个线程同时运行，可能更快耗尽额度，随后受到节流。`memory.max` 给出约 1 GiB 上限，回收仍不能满足时可能触发该组的 OOM（Out Of Memory，内存不足处理）；`pids.max` 约束任务数量，防止无限创建进程或线程。CPU 超限主要导致等待，内存超限可能导致执行失败。[cgroup v2 控制器](https://docs.kernel.org/admin-guide/cgroup-v2.html)

CPU 配额、权重和绑核分别控制时间上限、竞争时的相对份额、允许在哪些 CPU 上执行。暂停或冻结只让进程暂时不执行，不自动把内存送还系统。`freeze` 与内存回收是两个接口，DSec 的暂停机制会组合它们。[cgroup v2 官方源文](https://github.com/torvalds/linux/blob/master/Documentation/admin-guide/cgroup-v2.rst)

### 特权、系统调用与对象访问

**Capability（能力位）** 将传统 root 的部分特权拆成独立权限，例如网络管理和追踪其他进程是不同权限。去掉不必要的能力位，可以让程序即使在某个空间内拥有 root 身份，也不能执行对应特权操作。它改变授权判断，并没有从内核删除那段功能或消除其中所有漏洞。[Linux capabilities](https://man7.org/linux/man-pages/man7/capabilities.7.html)

**`no_new_privs`** 限制进程及后代在执行新程序时获得额外特权，例如阻止通过 set-user-ID 程序提升权限。它让后续执行遵守“不能凭换一个可执行文件扩大权限”的约束，不撤销现有权限，也不决定某个目录能否写入。bubblewrap 利用这些内核原语构造环境，实际保护范围由调用参数和上层策略决定。[bubblewrap README](https://github.com/containers/bubblewrap/blob/main/README.md)

**Seccomp（secure computing）filter** 在 syscall 入口按调用号、架构和部分参数判断允许、拒绝或采取其他动作。过滤程序是一段在这个入口执行的规则代码，只读取入口提供的调用信息；其程序格式属于 BPF，源自 Berkeley Packet Filter。环境不需要某类调试接口时，可以禁止它。本处 seccomp BPF 与后文网络观测中的 eBPF 应按具体挂接点理解。

Seccomp 不是文件路径授权器。`openat` 参数中的路径是用户内存地址，普通 seccomp filter 不能沿这个指针读取任意字符串，因此“只允许打开某个路径”不能简单实现为检查指针数值。它也无法理解已获准的网络请求是否在泄露数据。官方文档提醒，seccomp 是构建沙箱的一项工具，不构成完整沙箱。[seccomp filter](https://docs.kernel.org/userspace-api/seccomp_filter.html)

**LSM（Linux Security Modules，Linux 安全模块）** 在内核访问操作的钩子上执行安全策略。AppArmor 可以约束文件和其他操作；Landlock 允许非特权程序对自己及后代施加部分对象访问限制，其能力随内核和 ABI（应用二进制接口）版本变化。“目录在资源视图中可见”和“这个进程获准读写目录”，由此可以分别控制。[Landlock 文档](https://docs.kernel.org/userspace-api/landlock.html)

### 网络连接与凭证

网络管控至少有三层：接口能否到达目标、目标是否允许、应用请求是否授权。IP 与端口过滤控制连接范围；代理可检查域名、HTTP 方法和路径；凭证代理可在许可后替请求注入真实密钥。NAT（Network Address Translation，网络地址转换）处理地址转换与出网路径，本身不表达“只能访问这些服务”。

把高权限 API key 写入环境变量后，文件隔离不会使它失去高权限。更细的做法是由受控代理保管密钥，Agent 只提交有范围的请求，代理验证后执行。它增加策略与审计成本，但将可执行代码与外部身份分开。Meta Muse 公开了这种分层设计。[Muse 安全架构](https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse)

所以“开了容器”不足以说明安全配置。需要检查用户映射、挂载、设备、socket、能力位、syscall、对象权限、网络出口以及管理接口。同一容器引擎可以构造出保护范围相差很大的环境。

## 4. 容器、gVisor、microVM 与 WASM 的执行链

小图的箭头表示调用经过的层，不表示各层拥有同一种权限：

```text
普通 Linux 容器
程序 → syscall → 所在机器的 Linux 内核 → 文件/网络/设备
                  ↑ namespaces、cgroups、seccomp、LSM

gVisor
程序 → 被拦截的 syscall → Sentry 实现 Linux 接口
                            → 受限宿主调用 / Gofer 文件服务
                            → 宿主 Linux 内核

Firecracker microVM
程序 → syscall → guest Linux 内核 → 虚拟设备 / 虚拟 CPU
                                      → Firecracker VMM + KVM
                                      → 宿主内核与硬件

WebAssembly
WASM 模块 → runtime 执行与内存检查
              → 获准的 host imports → 外部文件/网络等能力
```

**普通容器** 复用所在机器的 Linux 内核，为进程建立资源视图和限制。如果容器跑在云 VM 内，“所在机器”就是那台 VM，它共享 guest kernel（客户机内核），VM 外还有另一层边界。不要默认所有容器都直接共享物理宿主内核。优势是 Linux 程序兼容性高，无需为每环境启动内核；代价是这些进程仍共同依赖所在内核的安全性。[Docker 安全](https://docs.docker.com/engine/security/)

**gVisor** 把大部分 Linux 系统接口放到用户态 Sentry 中实现。应用以为在调用 Linux，这些调用先由 Sentry 实现语义，再经较小宿主接口取得资源；文件可经过 Gofer 服务。它减少不可信应用直接触及宿主内核的范围，代价可能表现为接口兼容性差异、额外处理与通信成本，依赖具体 workload（工作负载）。[gVisor 架构](https://gvisor.dev/docs/architecture_guide/intro/)

其平台负责怎样截获和执行应用：当前默认 Systrap 利用 seccomp，也有 KVM 平台。后者使用 KVM，并不表示启动了完整 Linux guest kernel。识别方案要看“Linux 接口在哪里实现”，不能只看 KVM 一词。[gVisor platforms](https://gvisor.dev/docs/architecture_guide/platforms/)

**KVM（Kernel-based Virtual Machine）** 提供 Linux 的硬件虚拟化接口；**VMM（Virtual Machine Monitor，虚拟机监控器）** 建立和管理 VM。VMM 打开 `/dev/kvm`，通过 `ioctl` 创建 VM、设置 guest 内存、创建 vCPU（虚拟 CPU）并进入执行。`ioctl` 是通过文件描述符向设备或内核接口发送控制请求的系统调用。普通 guest CPU 指令可由硬件执行，特定事件再退出到管理层，通常不需要逐条软件解释所有指令。[KVM API](https://docs.kernel.org/virt/kvm/api.html)

**Firecracker** 是基于 KVM 的精简 VMM，提供运行 Linux guest 的 microVM。应用 syscall 首先触及 guest kernel；即使应用攻破 guest，跨到宿主仍需越过虚拟化相关边界。设备模型、VMM 和 KVM 自身仍需保护与更新；宿主网络过滤、jailer 和 seccomp 提供另外的约束。精简设备与管理功能有助于缩小接口面，也意味着通用 GUI、设备和系统能力要逐项确认。[Firecracker design](https://github.com/firecracker-microvm/firecracker/blob/main/docs/design.md)

内核通常把内存按固定大小的 **页（page）** 管理。程序使用自己的虚拟地址，操作系统把它们映射到实际存放数据的内存；页是分配、映射和回收的基本单元。文件读入 RAM 后，内核可能保留内容供下次读取，这部分叫文件页缓存。共享同一文件，不一定等于共享存放文件内容的内存页。虚拟机内还有 guest 与 host 两套地址映射，这也会影响后面的缓存与回收。[KVM 内存接口](https://docs.kernel.org/virt/kvm/api.html)、[cgroup 内存管理](https://docs.kernel.org/admin-guide/cgroup-v2.html)

**WASM（WebAssembly）** 走程序格式与语言 runtime 路线。模块使用线性内存，即 runtime 管理的一段逻辑内存空间；越界访问与非法控制流等由验证、检查和页保护机制约束。外部文件与网络能力通过 host imports（宿主导入函数）暴露。即使模块不能随意触及宿主内存，如果宿主给它“任意路径读文件”的导入函数，授权仍会过大。[Wasmtime 安全模型](https://docs.wasmtime.dev/security.html)

WASM 不要求每条指令都解释执行，也不提供全套 Linux 兼容性。原生扩展要看是否移植、需要哪些系统能力；科学计算库并非都不可用，Pyodide 官方列表已有 NumPy、pandas、SciPy。[Pyodide 包列表](https://pyodide.org/en/stable/usage/packages-in-pyodide.html)

四条路线可以比较执行链，但不宜排成无条件安全等级。威胁还包括配置失误、控制面、凭证和外部副作用；路线也可叠加，例如 VM 内再用容器划分工具权限。

## 5. 镜像、快照与恢复：先说清保存对象

镜像一般描述初始文件系统和启动配置。Python 包已在镜像里，不代表 Python 进程已启动，更不代表导入后的内存状态已保存。**OverlayFS（叠加文件系统）** 把共享 lower（下层）与可写 upper（上层）合成可见目录。读取未修改文件可来自下层；首次修改下层文件可能触发 `copy_up`，将所需对象复制到上层；删除下层对象需要记录“本层将它遮住”。它减少重复文件，支持独立写入，不保存局部变量、寄存器和网络连接。[OverlayFS 文档](https://docs.kernel.org/filesystems/overlayfs.html)

**EROFS（Enhanced Read-Only File System）** 适合不可变只读内容。DSec 将 base、workspace、toolkit 分层版本化，结合压缩、随机读取与 OverlayFS，按需供给共享内容。复用镜像省文件分发、磁盘和缓存等成本，不会给应用凭空增加隔离。[DSec §5.1–5.3](https://arxiv.org/html/2609.22978v1)

**COW（Copy-on-Write，写时复制）** 先共享内容，某个使用者写时再产生独立副本。它可用于文件，也可用于内存页，两者实现与保护边界不同。下层文件的 copy-up 并不一定只复制修改的几个字节，粒度由实现决定；COW 不能等同任意精度、零成本复制。

**Snapshot（快照）与 checkpoint（检查点）** 表示阶段状态保存，产品的命名不统一。必须问：保存磁盘、进程内存和寄存器、VM 内存与设备，还是应用对话、轨迹与模型 KV？Firecracker 快照可保存 guest 内存和执行相关状态，但磁盘配套、网络和外部服务有各自条件；克隆还需处理身份、随机性及连接。[Firecracker snapshot](https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/snapshot-support.md)

**Lazy paging（按需供页）** 改变恢复时的搬运顺序：先恢复运行结构，实际访问某页时才装入，而非提前读取整份内存。Linux `userfaultfd` 允许用户态服务处理指定地址区域缺页，可用于这类设计。快照定义“保存什么”，COW 定义“何时分副本”，按需供页定义“何时装入”；它们可以组合，不是同义词。[userfaultfd](https://docs.kernel.org/admin-guide/mm/userfaultfd.html)

按需恢复可缩短部分启动等待，却把成本转到后续缺页和存储访问。冷缓存首次访问可能阻塞，并发恢复可能集中压向存储。评估要区分“API 返回可用”“首命令完成”“稳定执行吞吐”，不能只看恢复接口返回时间。

Agent 至少有五种状态：对话与控制循环、文件系统、进程/VM 内存、模型 KV、外部副作用。KV（Key/Value）是 Transformer 推理中缓存的注意力键和值，用于减少重复上下文计算，不是 shell 内存。一次外部写请求不会因 VM 回到旧快照而消失。恢复必须识别操作是否已完成、可否重试，必要时保存结果、用幂等键或要求确认。“无损”要指明状态对象与故障范围。

## 6. 大规模调度：环境常驻与算力分配可以拆开

一次 rollout（从任务开始到结束的交互轨迹）交替经历模型生成、工具计算、I/O 等待。等待时要保留状态，未必需要持续占 CPU。教学假设：100 个环境保留文件和内存，此刻平均只有 10 个执行命令，每个最多有效用两颗 CPU。瞬时工作量约需 20 个 CPU 的执行能力，还需预留突发与系统开销；每环境长期独占两颗会浪费等待份额。内存不能按相同比例自动缩小。

实现这种拆分经过几层决策：

```text
请求进入队列 → 授权与配额检查 → placement 选候选节点
  → admission 确认实际容量 → 启动/复用环境
  → action 开始时分配 CPU/GPU/API 份额
  → 内核安排线程运行 → 结果保存、续租或回收
```

**Queue（队列）** 决定哪些请求等待；**placement（放置）** 决定去哪台节点；**admission（准入）** 决定此刻是否可占资源。集群视图有延迟，选到“看起来空闲”的节点后仍要本地准入。Kubernetes scheduler 的 filter、score、bind 是放置流程；resource request 参与调度，limit 由节点 runtime、内核等执行，二者不同。[Kubernetes 调度器](https://kubernetes.io/docs/concepts/scheduling-eviction/kube-scheduler/)、[requests 与 limits](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/)

**本地 CPU scheduler** 选择 runnable（当前可运行）线程何时在哪颗 CPU 上执行。环境被放到节点后，线程仍受配额、亲和性、竞争和内核调度影响。CPU、RAM、磁盘、网络和 API QPS 都可能是瓶颈，不能只看空闲核心数。

下面是通用工程推导，不能自动归给某家厂商。**Backpressure（背压）** 在下游容量不足时向上游反馈，降低并发、排队或拒绝，避免无限积压。队列要有容量、超时、取消与优先级规则。**Warm pool（预热池）** 保存已准备好的对象，要说清是 VM、容器、Python 进程还是推理缓存；过大的池也耗空闲内存。

**Lease（租约）** 给资源控制权设期限，持有者按协议续租。重试或网络分区时旧持有者可能仍在运行，设计上还可用递增 epoch（世代号）和 fencing（阻止旧控制者继续写）机制。租约到期只给出失效条件，真正停止旧执行还依赖节点、存储或代理拒绝旧世代。

控制器通过 reconciliation（对账）比较期望与实际状态，收回无人负责的环境。这一段是故障设计推导，不是 OpenAI 内部实现声明；公开 lifecycle 文档给出了单一 owner、重读当前 session、协调关闭与新输入等契约，Symphony SPEC 则给出轮询、占用、并发和对账流程，足以说明为什么仅收到一次事件不能可靠判断资源该销毁。[OpenAI environment lifecycle](https://developers.openai.com/api/docs/guides/agents-api/environments/lifecycle)、[Symphony 固定 SPEC](https://github.com/openai/symphony/blob/be10a1b79df723d6d7612b5651c8522704dafb2e/SPEC.md)

**Cleanup（清理）** 覆盖进程树、可写层、挂载、网络接口、凭证引用、临时对象和配额账目。终端断开不保证子进程结束；删目录不保证没有打开的句柄。重用环境要明确保留什么、清除什么、清理失败后能否交给下一任务。低启动时延与干净初始状态需要分别验证。

## 7. OpenAI 与 Anthropic：本地命令、云端任务和长期助手

### 本地命令如何变成 OS 规则

本地 coding Agent 常让模型提出命令，再由宿主把 permission profile（权限配置）翻译为 OS 规则，启动受约束 shell；子进程继承相应限制。Approval（批准）规定谁可许可边界外动作，sandbox 则实际执行限制，二者职责不同。

本轮固定 Codex 源码中，Linux/WSL2 路径利用 bubblewrap 的挂载、用户和相关进程空间，将基础路径只读挂载，把指定可写目录重新挂载为可写，再把受保护子路径设回只读，施加 `no_new_privs` 和 seccomp。它仍共享所在 Linux 内核。管理网络代理时，network namespace 与桥接路径限制出口，代理检查域名；单独设置代理环境变量不等于强制隔离。macOS 路径使用 Seatbelt 的动态规则约束路径、网络和服务。源码存在某个旧 backend 不代表当前默认采用它。[Codex Linux 固定 README](https://github.com/openai/codex/blob/799324821d36a822923cee7814d3b80f7ec3cf99/codex-rs/linux-sandbox/README.md)、[Seatbelt 源码](https://github.com/openai/codex/blob/799324821d36a822923cee7814d3b80f7ec3cf99/codex-rs/sandboxing/src/seatbelt.rs)

Windows 的同类约束由不同原语承担。以下描述已公开实现的职责，不代表每个版本、配置都启用全部机制：

| Windows 对象 | 负责什么 | 不负责什么 |
| --- | --- | --- |
| Restricted token（受限访问令牌） | 减少进程身份可用的特权与访问权 | 不新建 guest 内核 |
| ACL/ACE（访问控制列表及条目） | 决定身份对文件等对象的权限 | 不替代网络策略 |
| Job Object（作业对象） | 组织进程树、执行相关生命周期约束 | 单独不能实现目录或出口授权 |
| WFP（Windows Filtering Platform） | 按身份等条件过滤网络流量 | 不解释全部应用请求语义 |

Codex 文档区分独立低权限用户的 setup 路线与当前用户派生的受限令牌路线，不能把 setup 需要提升权限误写成命令以管理员运行。本轮源码还有默认未开启的新 Windows backend，不能据代码存在断言用户已使用。Anthropic sandbox-runtime 同样在 Linux 使用 bubblewrap、网络空间与代理，在 macOS 使用 Seatbelt；其 Windows alpha 不等于 Claude Code 已正式支持 native Windows sandbox，产品文档仍要求相应场景使用 WSL2。[Codex Windows 文档](https://learn.chatgpt.com/docs/windows/windows-sandbox)、[固定 token/process/WFP 实现](https://github.com/openai/codex/tree/799324821d36a822923cee7814d3b80f7ec3cf99/codex-rs/windows-sandbox-rs/src)、[Anthropic runtime](https://github.com/anthropics/sandbox-runtime/blob/e87c1096eef31482491512eb218428f74a56e2b9/README.md)、[Claude Code sandboxing](https://code.claude.com/docs/en/sandboxing)

这些资料说明文件与网络边界，不能据此补写每条本地命令都有 cgroup CPU/RAM 额度。技术原语可用与产品实际配置，要分别举证。

### 云端任务怎样保留环境

当前 Codex Cloud 文档将 reusable environment（可复用环境）描述为仓库、依赖、工具和访问配置；Publish 保存准备好的文件系统，新 task 获得独立 workspace，既有 task 保留自身修改和工具。保存文件层不等于保存运行进程；文档未公开底层存储格式、hypervisor（虚拟化管理层）、宿主池与 placement。OpenAI 的 hosted environments 和 hosted Shell 也有各自网络与生命周期规则，不能把一个入口的默认许可传播到全部产品。[Codex Cloud environments](https://learn.chatgpt.com/docs/environments/cloud-environments)、[Agents API hosted environment](https://developers.openai.com/api/docs/guides/agents-api/environments/openai-hosted)、[Responses Shell](https://developers.openai.com/api/docs/guides/tools-shell)

Anthropic 已公开三个不同产品路径：claude.ai code execution 使用 gVisor container 与按 session 的临时文件系统；Claude Code 是本地命令隔离；Cowork 使用本地 Linux VM，macOS 基于 Apple Virtualization framework，Windows 基于 HCS。Cowork 后来把 Agent harness（驱动模型与工具循环的执行框架）移出 VM，使 VM 启动失败时仍可答复，代码执行仍在 VM 内。不能把某个路径推广成“Claude 一律使用某种 VM”。[How we contain Claude](https://www.anthropic.com/engineering/how-we-contain-claude)

Managed Agents 更明确地拆成 brain（模型与 harness）、hands（沙箱及工具）和 session（持久事件）。Harness 不必先等 container 启动才推理；需要工具时再 provision 环境，执行失败作为 tool error 返回，harness 故障则从外置事件日志恢复。Session 不是模型 context window（上下文窗口），事件可按需取片段。它说明计算循环、工具环境和持久记录可以各自伸缩；这是 serving（服务执行）架构，不能当作 RL 训练集群披露。[Managed Agents](https://www.anthropic.com/engineering/managed-agents)

Anthropic 还给出出口授权反例：域名允许访问，并不保证访问正确账号或执行正确动作；官方方案进一步校验 session token 和请求。它解释了为何 allowlist 之后仍要凭证与请求规则。部署建议中列出 Firecracker，也不证明产品实际全采用它。[How we contain Claude](https://www.anthropic.com/engineering/how-we-contain-claude)、[Agent SDK secure deployment](https://platform.claude.com/docs/en/agent-sdk/secure-deployment)

### dots 的公开能力与未知基础设施

OpenAI 官方 **2026-09-29** 发布 dots。文档描述 cloud computer/browser 保留文件、软件和浏览器 sessions，用户电脑关机后仍可工作；支持接管、归还控制、并行后台 agents 与可见 cloud threads，也能使用已有 Codex cloud environment。连接个人电脑时则要求电脑在线、应用打开并单独授权。[Meet dots](https://learn.chatgpt.com/docs/dots)、[Computers and apps](https://learn.chatgpt.com/docs/dots/computers-and-apps)、[官方发布 RSS](https://openai.com/news/rss.xml)

可据此解释产品层关系：任务与记忆持续存在，执行选择云电脑、后台任务或已连接本地电脑，再等待结果与人工决定。它没有公开 hypervisor、container/microVM、存储、预热池、fleet 规模或调度算法。“自己的电脑”不能证明永久绑定一台始终运行的 VM。暂停主任务不一定停止已委派任务和未来 schedule，要按文档分别处理。[Tasks and memory](https://learn.chatgpt.com/docs/dots/tasks-and-memory)、[Controls](https://learn.chatgpt.com/docs/dots/controls)

两家 frontier RL rollout fleet 的完整实现仍未由本轮公开资料核准。Anthropic 的 GKE 资源讨论属于 eval，不能推出训练也用同样集群；OpenAI RFT 文档公开训练循环抽象，不披露多步骤 Agent 环境池、快照与调度。E2B/Modal 被列为接入路线，也不证明它们是内部训练或 hosted backend。[Infrastructure noise](https://www.anthropic.com/engineering/infrastructure-noise)、[RFT 文档](https://developers.openai.com/api/docs/guides/reinforcement-fine-tuning)

## 8. DeepSeek DSec：环境、镜像与内存一起优化

DSec（DeepSeek Elastic Compute）当前论文为 **2609.22978v1，2026-09-19**。它覆盖 FnCall、container、Firecracker microVM、full VM 等后端。FnCall 将函数调用交给预建环境，full VM 提供更完整的操作系统与设备能力；统一 SDK 和执行接口没有统一它们的隔离与保留语义。Container/FnCall 位于 QEMU/libvirt VM 内，前者是虚拟机运行软件，后者负责虚拟机管理；容器共享那台 guest 内核。评估中的 microVM 直接跑裸机，统一 API 没有抹掉这些执行链差异。[DSec §2–3](https://arxiv.org/html/2609.22978v1)

放置先过滤能力与健康，再用 power-of-k choices，抽样若干候选节点并比较负载。放置服务参考 watcher 定期采集的节点视图，并计入近期尚未被该视图记录的本地分配；执行节点的 edge 服务最后检查实际容量，拒绝后再改选。它减少全局同步依赖，并承认观察与实际容量可能不同；完整公平与灾难恢复协议没有公开。[DSec §3.2、§7](https://arxiv.org/html/2609.22978v1)

DSec 把不可变文件层组织成 EROFS 只读镜像，后端放在 **3FS 分布式存储** 中，即由多台存储节点共同提供内容的系统。执行节点只按需取实际工作集，本地保留元数据与写入层。元数据包括目录和文件位置等组织信息；工作集是这次执行真正访问的数据。于是，大镜像无需在每环境启动前完整解包，也不意味每个环境都会读完全部内容。[DSec §5.1、§5.3](https://arxiv.org/html/2609.22978v1)

MicroVM 还需要把文件层提供给 guest 的块设备。**OverlayBD** 提供块级分层与按需读取路径；**ublk** 是 Linux 的用户态块设备接口，让用户态服务处理相关读写请求。可把块理解为磁盘读写单元：guest 请求某段块数据，宿主服务判断来自共享只读层还是本地改动，再取得内容。它与容器直接组合挂载目录的路径不同，不能用“都用了 overlay”省略 microVM 的设备层。[DSec §5.3、§7](https://arxiv.org/html/2609.22978v1)

内存路径先解决重复缓存。通常文件内容从存储进入宿主后可能留在宿主页缓存；guest 又把读到的内容放进自己的文件页缓存。许多 VM 读取同一只读内容时，guest 各留一份，就会重复占内存。**Virtio-pmem** 是暴露给 guest 的虚拟持久内存设备；DSec 经它提供只读层，使用 **DAX（Direct Access，直接访问）** 让相关文件页映射到宿主支撑的页，减少逐 guest 复制文件缓存。这不意味任意内存都可跨 VM 共享，也仍有映射、元数据和冷访问成本。[DSec §5.2](https://arxiv.org/html/2609.22978v1)

再看冷页回收。**DAMON（Data Access MONitor）** 采样内存页访问，帮助识别长时间很少使用的文件页；guest 回收这些页后，其内存管理器将它们列为空闲。**Balloon free-page reporting** 随后向宿主报告空闲页，宿主才能释放对应 backing memory（支撑 guest 地址的实际内存）。这是一条“采样识别 → guest 回收 → 空闲报告 → 宿主释放”的链，文件内容仍可从存储重新读取；不能把 balloon 理解为任意在用页都能无成本收走，也不能把释放缓存说成删除文件状态。[DSec §5.2](https://arxiv.org/html/2609.22978v1)

Container 暂停先 `docker pause` 冻结，再允许 swap（把内存页置换到存储），用 `memory.reclaim` 请求内核回收该控制组的内存；恢复先以 `MADV_WILLNEED` 提示内核预先准备将要访问的数据，再解除暂停，提示不保证预取已经完成。MicroVM 保存内存和执行快照后终止 Firecracker，恢复建立新进程加载。前者冻结与换出，后者保存与重建；`pack_diff` 则只描述增量磁盘快照。[DSec §6.1、§6.3](https://arxiv.org/html/2609.22978v1)

DSec 将 LS（latency-sensitive，时延敏感）与 BE（best-effort，尽力而为）任务区分。一个物理核心可能提供多个硬件线程，它们共享该核心的部分资源。Core scheduling（核心调度）让内核避免把 BE 与 LS 同时安排到这些共享核心资源的线程上；`SCHED_IDLE` 则让 BE 在已有可运行 LS 时让出 CPU。它缓解干扰，不隔离全部缓存、带宽和频率竞争。[DSec §5.2、§8.5](https://arxiv.org/html/2609.22978v1)

训练还存在 reward hacking（通过不符合真实目标的方法取得奖励）。DSec 用 AppArmor 和 eBPF 网络规则限制进程与分阶段出口，缓解部分异常行为，不能声称消除所有作弊或内核攻击。控制循环与环境生命周期错位也会丢状态，所以从 DeepSeek-V4.1 起，将 worker 和 sandbox 放在可抢占 GPU 池外保留，让 trainer 重连；恢复尤其要复用已完成操作结果，避免重放非幂等命令。[DSec §6.2、§6.5](https://arxiv.org/html/2609.22978v1)

这些设计改善基础设施供给、资源使用和恢复。性能实验有具体集群、负载与基线，不能转换为模型智能提升。部分存储源码公开也不等于全套平台开源，跨节点状态恢复和成本仍有空白。

## 9. Xiaomi MiMo：环境、动作和推理缓存三层

MiMo-V2.6 的 **2026-09-22 技术报告 §6** 主要解释 rollout 系统，没有公开到 DSec 那样的 guest 与镜像深度。报告中的 isolated sandbox 与固定初始状态，不足以判定后端为 Docker、gVisor 或 Firecracker。[MiMo-V2.6 固定报告](https://huggingface.co/XiaomiMiMo/MiMo-V2.6-Pro-RL/resolve/73875d00b30a89ef8cc353a0b60b0e9f9561952d/MiMo_V2_6_technical_report.pdf)

**Harness Pool** 固定一批持久 Ray host actors。Ray actor 是可保留状态和接收调用的工作进程。同一个 host 进程同时推进多条 rollout，每条各自保存交互进度；报告把这些被复用的运行单元称为 tenant。这里的 tenant 是轨迹运行单元，不代表每条都有独立 VM 或内核。事件循环在等待与就绪任务间推进，阻塞调用会卡住同循环其他任务，所以环境操作和 tokenization（文本分词编码）等移到后台线程。线程解决阻塞和并发，不构成恶意租户内核隔离；actor pool 也不等于镜像池。[报告 PDF p27–28](https://huggingface.co/XiaomiMiMo/MiMo-V2.6-Pro-RL/resolve/73875d00b30a89ef8cc353a0b60b0e9f9561952d/MiMo_V2_6_technical_report.pdf)

**Payload Porter** 把大轨迹内容写入分布式 KV/object store（键值或对象存储），driver（集中协调进程）主要调轻量元数据，消费者按需读数据范围。多轮截图也尽量只传增量，避免反复经过 driver。这里 KV 指存储接口中的键值，不是模型注意力缓存。解决的是搬运与集中进程瓶颈，“object store”不自动意味着灾难持久恢复。[报告 PDF p28–29](https://huggingface.co/XiaomiMiMo/MiMo-V2.6-Pro-RL/resolve/73875d00b30a89ef8cc353a0b60b0e9f9561952d/MiMo_V2_6_technical_report.pdf)

**Sample Mixer** 决定接下来从哪类数据源启动多少条 rollout。它结合目标比例、实际接受率和耗时补足训练批次，派发时还检查剩余模型请求槽位，以及新请求预计占用的 KV 缓存。槽位限制同时推进多少请求，KV 容量限制这些请求能保留多少推理上下文；它们不是 sandbox 数量或文件配额。这是在控制训练数据分布，不能直接解释为企业租户公平 SLA（服务等级承诺）。[报告 PDF p29–31](https://huggingface.co/XiaomiMiMo/MiMo-V2.6-Pro-RL/resolve/73875d00b30a89ef8cc353a0b60b0e9f9561952d/MiMo_V2_6_technical_report.pdf)

**Context Cache** 处理另一项成本：工具运行时，模型暂时停止生成，下次却还需要已经算过的上下文。MiMo 在同一 policy version，也就是同一策略模型版本下，复用注意力 KV 和相关推理状态。生成时放在 GPU 的 HBM（高带宽显存）；工具等待时搬到 pinned host memory，即固定页宿主 RAM，由单独的 CUDA stream 安排搬运操作。固定页是暂时不让操作系统换出的内存，便于设备按确定地址搬运；CUDA stream 是 GPU 操作的一条有序队列。等待轨迹因此少占显存，仍消耗 RAM 和搬运资源。这份缓存不保存 shell 进程、文件系统或已经发生的外部写入。[报告 PDF p32](https://huggingface.co/XiaomiMiMo/MiMo-V2.6-Pro-RL/resolve/73875d00b30a89ef8cc353a0b60b0e9f9561952d/MiMo_V2_6_technical_report.pdf)

另一篇 **ARL-Tangram，2603.13019v1** 按 atomic action（原子动作，一次有明确执行边界的工具操作）分配外部资源。环境保留内存与状态，命令开始时改 Docker cgroup CPU 配额和 CPU 集合，结束返还 CPU。程序自身还要支持并行，否则多给核心不保证加速。[Tangram §3–5.2](https://arxiv.org/html/2603.13019v1)

GPU 外部服务先初始化，在 CPU RAM 留可恢复状态，需要时驻留 GPU；完成后可留缓存，不足时驱逐或恢复。这里 eviction（驱逐）的对象是服务 GPU 驻留缓存；CPU 调度的候选延后也不等于强杀命令。论文支持 MiMo series，不证明 V2.6 每环节采用相同参数。MiMo Code 的 QuickJS/WASM 工作流和应用 checkpoint 又属于语言与应用层；开源 uni-agent 有多种 backend，不证明内部训练统一选择。[Tangram §4.2、§5.3](https://arxiv.org/html/2603.13019v1)、[MiMo Code 工作流](https://mimo.xiaomi.com/blog/mimo-code-long-horizon)、[uni-agent 固定文档](https://raw.githubusercontent.com/XiaomiMiMo/uni-agent/c63e0b01c375ebede95e01fe92bc367df24e5bf3/docs/source/concepts/sandbox.md)

## 10. Meta Muse 与国内云端助手：持久用户环境

Muse Spark 是模型家族；**2026-09-08 发布的 Muse** 是个人 Agent 产品。Muse 提供每用户 dedicated Linux VM；dedicated 描述环境归属，不意味独占物理服务器。Hypervisor、VM 类型、宿主密度和回收策略未公开。[Muse 产品发布](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/)、[Muse Spark](https://ai.meta.com/blog/introducing-muse-spark-msl/)

用户 VM 内再分执行区和安全服务区。执行区采用 systemd-nspawn 创建容器，运行 Hatch（驱动模型与工具循环的框架）、工作区和工具。它使用前文的用户、文件系统和网络隔离规则，仍共享这台用户 VM 的 Linux 内核。容器 root 映射为外侧非特权用户，并配置独立 rootfs（根文件系统）、虚拟网卡、syscall 和能力位限制。[Muse 安全全文](https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse)

Muse 把这个执行区称为 runtime cell。安全模型、privsep workers（只承担指定权限操作的工作进程）、凭证服务 authd 和出口检查服务 Sentinel 放在 cell 外，仍位于同一用户 VM。它们用本机 Unix socket 通信：`SO_PEERCRED` 让内核给出连接对端身份，服务再按 ACL（访问控制列表）决定能否调用，不能只信任请求里自称的用户身份。[Muse 安全全文](https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse)、[Unix 对端身份接口](https://man7.org/linux/man-pages/man7/unix.7.html)

Authd 保存凭证，runtime 只见替代 token，worker 按凭证 allowlist 工作；Sentinel 检查出口与 connector action，批准后在网络边界注入真凭证。它检查 hostname、最终 IP、端口、协议、HTTP method/path 与解析后请求，限制 SSRF（Server-Side Request Forgery，诱导服务端访问非许可目标）。代码没有真密钥可读，也不代表它能任意使用代理：代理仍按请求决定授权。[Muse 安全全文](https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse)

**eBPF** 允许在内核指定位置运行受约束的程序。Muse 利用内核/eBPF 追踪进程是否读取过用户数据；读取后给进程加标记，收紧它无需再次询问即可获得的出口许可。这种污点追踪记录数据接触状态，不是对所有信息流的完整证明。官方仍承认 prompt injection（提示词注入）尚未解决。[Muse 安全全文](https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse)、[BPF 底层执行格式](https://docs.kernel.org/bpf/standardization/instruction-set.html)

CDP（Chrome DevTools Protocol）是控制和检查 Chrome 浏览器的协议。Muse 把 CDP broker，也就是代为处理浏览器控制请求的服务，放在 runtime 外。Browser subagent 主要读取 accessibility snapshot：页面中元素、名称和可执行操作的结构化表示；它没有任意页面脚本或浏览器进程执行接口。用户接管浏览器或填凭证时，Agent 暂停。[Muse 安全全文](https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse)

产品里的 memory 指跨会话保留的信息，与程序运行时的 RAM 是不同对象。Muse 公开的是把持久应用状态放在 runtime 和凭证存储之外的 PostgreSQL 数据库中并备份；这不能证明进程 RAM、寄存器或运行中浏览器状态都通过 VM 快照保存。Meta 计划提供的机密虚拟机模式，当时仍是计划与少数受信测试者阶段，不能写为普遍上线；现有 Secure VM 也没有从技术上阻止运营方因运维需要访问所有数据。[Muse 产品设计](https://introducing.muse.ai/)、[Muse 安全全文](https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse)

国内公开深度不一，适合比较“已知到哪里”：

| 产品或路线 | 当前可确认对象 | 尚未公开或本轮未核准 |
| --- | --- | --- |
| 腾讯 LightVela | 托管 Hermes Agent，每实例专属环境；同实例可有多 Bot，保留应用记忆、文件和定时任务 | VM/container、每 Bot OS 边界、RAM snapshot、宿主密度、凭证代理 |
| 火山引擎 ArkClaw | 云端助手、持久存储、网页交互；文案说明隔离、无公网 IP、NAT 出网 | VM/container、每用户或伙伴的 OS 边界、快照、出口 allowlist、回收协议 |
| 腾讯 Lighthouse 云端 OpenClaw | 用户购买云服务器实例，以模板托管 Agent，有云桌面和系统盘快照 | guest 内 Agent 隔离、进程/浏览器 checkpoint、按任务回收 |
| 阿里云 Agent Sandbox | 基础设施公告明确每沙箱独立 VM，支持休眠、恢复、clone | 完整实验条件、宿主密度；不能推断上述助手都采用它 |

来源为 [LightVela 核心概念](https://lightvela.com/docs/core-concepts/)、[ArkClaw 产品页](https://www.volcengine.com/product/arkclaw)、[Lighthouse 云端 OpenClaw](https://cloud.tencent.com/act/pro/openclaw)、[阿里云 2026-09-22 公告](https://www.aliyun.com/product/news/30546)。ArkClaw 正文来自产品页明确引用的公开前端模块，属于官方文案，不能替代后端架构。

持久助手重在长期工作区、凭证授权与定时执行；短生命周期训练环境重在批量创建、初始状态和算力周转。LightVela 到期保留与 Lighthouse 停服规则不等于空闲 sandbox 回收；系统盘快照也可能漏掉未落盘内存。[LightVela 生命周期](https://lightvela.com/docs/plans/)、[Lighthouse 快照](https://cloud.tencent.com/document/product/1207/48546)

## 11. 校正选型文章，阅读性能声明

[知乎《Agent Infra: Sandbox 技术和选型》](https://zhuanlan.zhihu.com/p/1999938129465979624)提供了 Local、WASM、Docker、gVisor、microVM 的问题入口，但需加回条件。安全的低、中、高排序不能替代威胁模型；VM 边界和用户态系统接口不自动解决凭证或网络授权。训练仍执行不可信生成代码，不能凭“只是训练”认定 Docker 一定足够。保留文件不等于全部状态无损恢复，也不能回滚外部系统。启动、内存和 syscall 性能倍数仅在给定版本、硬件、负载及基线成立。[gVisor 架构](https://gvisor.dev/docs/architecture_guide/intro/)、[Firecracker snapshot](https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/snapshot-support.md)

读“更快”，先确认分母：环境创建、单命令、动作排队加执行、整条 rollout，还是训练总时间。再确认并发对象：常驻环境、运行命令、模型请求、累计样本、token 都不同。DSec 环境并发与 MiMo 每步累计 trajectory 不可直接比较，全平台并发也不能换成单宿主密度。

有用的评估应记录威胁与权限、Linux/浏览器兼容性、冷启动和热恢复分布、工作集与镜像大小、等待时资源保留、过载队列与失败、节点故障恢复、清理后残留。每项都对应前文执行者和状态对象。没有公开或实测证据的格子保留未知，才能明确下一步要测什么。

## 面试怎么回答

本文通过 AI 辅助调研与编写。一手资料由本轮研究任务读取，正文整合这些已记录的阅读范围；不是对厂商系统的独立安全审计或性能复现。公开代码分支与在线文档会变化，本文的“当前”均限于 2026-10-01 所核验的资料集合。

<details>
<summary>约一分钟口头回答</summary>

Agent sandbox 是受控执行环境，涉及隔离、访问权限、资源限制、生命周期和调度。容器用 namespaces 等原语隔离视图，共享所在内核；gVisor 在用户态实现 Linux 接口，减少直接宿主接口；Firecracker microVM 有 guest kernel，经 KVM 和精简 VMM 运行；WASM 靠 runtime 的内存和导入接口约束。还要配置 cgroups、syscall、文件规则以及网络和凭证代理。大规模系统将环境状态与每次动作算力拆开，按队列、放置和准入分配。镜像、磁盘快照、VM 快照与 KV 缓存保存不同对象，恢复不能撤销外部副作用。选型要按威胁模型、兼容性和实测负载，不能只凭安全与性能排名。

</details>

<details>
<summary>追问：用了 microVM，为什么还要 seccomp 和出口代理？</summary>

MicroVM 主要增加 guest 与宿主边界，VMM 仍经宿主接口工作，seccomp 可缩小相关接口面。出口代理判断另一对象：请求能否使用某身份访问某目标。Guest 内合法程序可能使用过大的 API 权限或外传数据，VM 不会判断这些授权条件。

</details>

<details>
<summary>追问：CPU 还给调度器后，环境怎样继续？</summary>

CPU 时间与环境状态是不同资源。命令结束降低配额或返还算力，内存、文件和控制循环可保留，下次动作再分 CPU。适合等待多、计算间歇的负载，仍付出 RAM、状态绑定与恢复成本。Tangram 的动作级分配、DSec 的冻结换出与 VM 快照分别是不同机制。

</details>

<details>
<summary>追问：snapshot、COW 与 lazy paging 分别解决什么？</summary>

Snapshot 定义保存状态和时间点；COW 先共享，写时分副本；lazy paging 等实际访问才装入页。分别影响恢复边界、复制成本与启动/缺页成本。磁盘 COW 不保存寄存器，按需加载也不扩大快照恢复范围。

</details>

## 技术自测：按层找到错误判断

以下是手算与机制分析，无部署要求。40 个常驻环境，每个最多保留 512 MiB 应用内存；此刻 8 个执行命令，每个可有效使用两颗 CPU。执行组各设 `cpu.max = 200000 100000`，共享只读镜像，环境各有独立 upper。A 保存磁盘快照后发出外部写请求，随即断线，管理器未收到结果。

1. 理想 CPU 时间需求与应用内存上限各多少？为什么不能都按 8/40 缩减？
2. CPU 配置是否保证两颗固定物理核心？暂停是否立即回收内存？
3. Lower/upper 保存什么？恢复 A 后能否直接重发外部写请求？
4. 集群视图落后，本地准入失败怎么办？无限重试有什么问题？

<details>
<summary>参考思路</summary>

理想需求 8 × 2 = 16 个 CPU 的时间能力；应用内存上限 40 × 512 MiB = 20 GiB，另有 runtime、内核、缓存开销，上限也不等于实际用量。等待状态仍需保存。配额不绑核，冻结不释放内存，需要另做回收、swap 或快照。

Lower/upper 组织文件，磁盘快照不保证进程、KV、外部状态。请求可能已完成，不能凭本地无结果就重发；要查结果、使用幂等协议或确认。准入拒绝是防线，应有有界改选、退避、排队或失败返回；无限重试放大控制面负载，还可能重复创建。分析时标出状态属于谁、谁执行限制、故障后怎样确定事实。

</details>
