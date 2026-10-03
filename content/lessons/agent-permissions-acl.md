# 企业智能体权限：Graph Connector ACL 与检索过滤怎样落地

一个文件已经被索引，相关性分数很高，但当前用户没有读取权限：它该在何处被排除？另一个用户昨天还能读，今天被移出组，索引里却仍保留旧成员关系：把过滤放在搜索之前，能解决这个问题吗？这两个问题分别涉及检索顺序与授权数据的新鲜度。顺序会影响召回，错误的授权数据则可能直接造成泄露。

本文先修是[智能体安全基础](#/lesson/agent-security-primitives)和[混合检索](#/lesson/hybrid-search)。核验日期为 2026-10-03，使用公开文档，例子全部是假设与手算。Microsoft 365 Copilot connectors（过去称 Microsoft Graph connectors）的 item ACL 是产品权限契约；Azure AI Search 的 vectorFilterMode 是另一个产品公开的向量过滤参数。本文把它们分开，Microsoft Search 的内部召回阶段未在这些文档中公开。

## 把文件权限写成可以计算的数据

访问控制列表（Access Control List，ACL）描述谁能访问一份资源。Graph connection 中的外部条目 externalItem 包含 acl、properties 和 content：分别承担访问规则、元数据和正文。这里的 acl 指的是用户在 Microsoft experiences 中查看条目的权限。连接器应用获得写索引的 API permission，与搜索用户获得读取某份文件的权限，是两层不同的授权。应用能上传文件，并不意味着每个用户都能读。[官方 item 说明](https://learn.microsoft.com/en-us/graph/connecting-external-content-manage-items)

一条 ACL entry 有三个字段。accessType 表示授权动作，grant 是允许，deny 是拒绝；type 表示主体类别；value 指定主体 ID。user 和 group 使用 Microsoft Entra ID 用户、组的 object ID；everyone 和 everyoneExceptGuests 使用 tenant ID；externalGroup 使用连接内的外部组 ID。Microsoft Entra ID 是组织的身份目录，object ID 是其中对象的标识，不应把显示名称、邮件地址或源系统用户名直接当作该字段。官方另列 unknownFutureValue，用于未来枚举值，业务代码需要明确处理未识别值，而不能猜成允许。[acl resource](https://learn.microsoft.com/en-us/graph/api/resources/externalconnectors-acl?view=graph-rest-1.0)

| type | 本文使用的含义 | value 对应什么 |
|---|---|---|
| user | 某个 Entra 用户 | 用户 object ID |
| group | 某个 Entra 组 | 组 object ID |
| everyone | tenant 中所有用户 | tenant ID |
| everyoneExceptGuests | tenant 用户但排除 guest | tenant ID |
| externalGroup | 源应用的非 Entra 组 | 该 connection 内的外部组 ID |

Microsoft 官方明确规定 deny 优先于 grant。假设某文件给 everyone grant，又给 U2 deny，U2 的有效权限是拒绝；不能因为他也匹配 everyone 就放行。对没有匹配允许项的用户，我们在例子中不给访问权限。模型不参与决定“这个人看起来应当能读”。[deny 优先规则](https://learn.microsoft.com/en-us/graph/connecting-external-content-manage-items)

源系统往往有自己的用户和团队。外部组 externalGroup 是把这类组映射到 Graph 权限模型的桥梁，成员可以是 Entra 用户、Entra 组或另一个 externalGroup。若源用户不是 Entra 用户，连接器要将其对应到 Entra 用户；原样传一个本地账号名不能完成映射。官方建议使用 externalGroup，而不是把组成员展开复制到每份文件的 ACL，这样成员变化不用引发大量文件更新。[externalGroup resource](https://learn.microsoft.com/en-us/graph/api/resources/externalconnectors-externalgroup?view=graph-rest-1.0)、[外部组同步指南](https://learn.microsoft.com/en-us/graph/connecting-external-content-external-groups)

以下是独立的小数据集：T 是 tenant；U1、U2 是员工，U3 是 guest；G 的成员只有 U1；源系统组 X 的成员只有 U2，已被同步为 externalGroup。字母都是教学代号，不是合法生产 object ID。

| 文件 | 已同步 ACL | U1 | U2 | U3 |
|---|---|---|---|---|
| F1 | grant group G | 允许 | 拒绝 | 拒绝 |
| F2 | grant externalGroup X | 拒绝 | 允许 | 拒绝 |
| F3 | grant everyone T；deny user U2 | 允许 | 拒绝 | 允许 |
| F4 | grant everyoneExceptGuests T | 允许 | 允许 | 拒绝 |
| F5 | grant group G；deny user U1 | 拒绝 | 拒绝 | 拒绝 |

以 U1 读取 F5 为完整演算：解析身份得到 U1 及其组 G；匹配 grant group G，暂时具备允许条件；再匹配 deny user U1，拒绝优先，最终不可见。U2 读取 F2 时，通过 X 的 membership 找到允许；他读取 F3 时，即使匹配 everyone，仍被 deny 排除。系统输出的是授权判断，而不是让 LLM 看过正文后承诺不引用。

这张表计算的是当前已同步的权限。如果源目录有继承、子项覆盖或共享例外，连接器需要先按源系统规则解析有效权限，再映射为 item ACL；只复制子文件表面上那一行权限可能不完整。这是设计要求，不是断言 Graph 能自动理解所有源系统的继承。对无法映射的主体或未知继承状态，可以将条目隔离待核对，避免用 everyone 填补缺失数据。

## 同步要更新授权状态，不只是更新正文

把 X 写进 F2 的 ACL，还需要让 Graph 知道 X 的成员。官方要求保持 externalGroup membership 与源系统同步。若 U2 被移出 X，文件正文和 ACL 可以完全不变，需要变化的是成员关系；若 F1 从 G 共享改成仅 U2，变化的是 item ACL；若文件被删除，变化的是 item 生命周期。把三种事件都视为“正文没变所以不用处理”，权限就会留在过去。[组成员同步要求](https://learn.microsoft.com/en-us/graph/connecting-external-content-external-groups)

全量同步扫描整个范围，适合初次建立或定期对账；增量同步处理变化，能减少重复工作。其能否捕捉 ACL、删除和成员撤销，取决于源系统的事件、版本号与连接器实现，不能从“增量”二字推导它只能处理内容。Graph 文档允许更新整个 item 或一个、多个 component；更新 API 明确允许只提交 acl。提交 acl 时，新 collection 会覆盖旧 collection，不是逐条追加。[item 同步指南](https://learn.microsoft.com/en-us/graph/connecting-external-content-manage-items)、[Update externalItem](https://learn.microsoft.com/en-us/graph/api/externalconnectors-externalitem-update?view=graph-rest-1.0)

假设 F3 原来有 everyone grant 和 U2 deny。若更新程序只提交一条新的 grant，而忘记保留仍有效的 U2 deny，覆盖语义会把拒绝规则删掉。安全的增量事件可以只触发这一份文件的更新，但应从源状态重建它的完整新 ACL collection，再提交。增量处理对象和提交完整 collection 并不矛盾。

再手算一次撤权窗口：10:00 源系统移除 U2 的 X membership；10:02 连接器读到事件；10:03 写入成员更新；之后搜索服务才反映该变化。几个时间是教学假设，官方页面没有为这里承诺统一生效时延。在索引仍按旧 membership 计算的窗口里，F2 可能被旧授权状态放行。preFilter 若使用同样的旧状态，也会放行。

因此验收需要从“API 接受了更新”继续追到“被撤权用户的新查询已不可见”，并覆盖缓存、嵌套组与重试。

例如连接器已经读取源版本 v8，却因网络错误没有写入 Graph；若先把 checkpoint 推到 v8，重启后可能误以为该事件已处理。一个可恢复的设计会区分“已读取”和“已确认写入”，保存待重试任务，并用源对象版本防止旧任务覆盖新权限。这是连接器设计示例，不是 Graph 对所有客户端提供事务 checkpoint 的承诺。针对同一文件串行更新或使用适合源协议的版本保护，也应明确重试与并发语义。权限任务积压时，不能只用正文更新的平均时延掩盖撤权延迟。设计上可记录源版本、同步 checkpoint、最后成功时间、事件积压及撤权探针，定期对账发现漏事件；权限未知或同步异常时采用何种拒绝、暂停或告警策略，应由数据风险决定。不能把所有 Connector 的权限同步一概写成即时，也不能说只有全量刷新才能撤权。

## 过滤阶段影响召回，不能替代正确的权限数据

安全修剪（security trimming）是在返回内容前按用户权限排除不可见条目。Graph ACL 文档规定查看权限，并未说明 Microsoft Search 使用 preFilter、postFilter 或怎样扩候选 TopN。开发者不能据此声称“Graph Connector 默认 post-filter”，也没有从这些来源得到“用户应切换其 pre-filter”的操作建议。

要理解过滤的检索代价，可以借用 Azure AI Search 已公开的机制。向量搜索按向量相似程度找候选；近似最近邻（Approximate Nearest Neighbor，ANN）用有限搜索换取效率。Azure AI Search 的 HNSW 索引分布在 shard，也就是分片上；vectorFilterMode 决定筛选条件在哪个阶段应用，条件写在可过滤的非向量字段上。把授权标签用作 filter 是一种应用设计，不能直接等同于 Graph item ACL 的原生实现。[Azure 向量过滤文档](https://learn.microsoft.com/en-us/azure/search/vector-search-filters)

为把顺序算清，下面假设分数可精确比较，没有 ANN 误差，k=3 表示要求至多三个向量结果。A、B 各是一片；“是”表示当前用户的正确权限条件允许该文件。此例与前面的 F1—F5 是两套独立数据。

| 分片 A：按分数排序 | 授权 | 分片 B：按分数排序 | 授权 |
|---|---|---|---|
| A1：0.99 | 否 | B1：0.94 | 否 |
| A2：0.98 | 否 | B2：0.93 | 是 |
| A3：0.97 | 是 | B3：0.92 | 否 |
| A4：0.96 | 是 | B4：0.91 | 是 |
| A5：0.95 | 是 | B5：0.90 | 是 |

preFilter 在各 shard 的 HNSW 遍历中应用条件，寻找匹配候选，再汇总全局 TopK。用上表精确模拟，A 提供 A3、A4、A5，B 提供 B2、B4、B5，汇总选分数最高的 A3、A4、A5。官方说，在索引存在足够匹配项的前提下，该模式返回 k 个结果；高选择性过滤可能增加遍历、CPU 与延迟。这不意味着任何查询都固定返回三个：如果总共只有两个授权文件，就没有第三个；最终响应还可能受其他查询设置影响。返回数量也不是相关性和所有 ANN 排序稳定性的同义词。[preFilter 条件与代价](https://learn.microsoft.com/en-us/azure/search/vector-search-filters)

普通 postFilter 先在各 shard 找未过滤候选，再在 shard 内过滤，最后全局汇总。A 的前三个是 A1、A2、A3，剩 A3；B 的前三个是 B1、B2、B3，剩 B2。汇总只得到 A3、B2 两个。A4、A5 虽然获授权且比 B2 更相关，已经在片内截断时丢失，之后过滤无法补回。这是授权相关文档的假阴性（false negative），即符合条件却没被召回。

strictPostFilter 先得到未过滤的全局 TopK，再筛选，是不同模式，核验时官方仍标 preview。上表全局前三个是 A1、A2、A3，过滤后只有 A3。不能把这个过程当作普通 postFilter 的官方定义。增加候选 k 可能改善后两者的召回，但会增加工作量，也不是对任意授权分布的保证；具体应测试过滤选择性、分片和查询参数。[三种模式的阶段区别](https://learn.microsoft.com/en-us/azure/search/vector-search-filters)

这三个输出都没有未授权文件，所以 postFilter 不天然不安全。真正的条件是：权限过滤必须由可信服务执行，未经授权的候选正文不能先进入 LLM、前端或用户可读日志，然后再从答案里删掉。preFilter 则不能修复错误 ACL、伪造用户 ID 或遗漏撤权。召回完整性与授权正确性要分别测试：前者问“该看见的是否找全”，后者问“不该看见的是否流出”。

查询身份同样是输入条件。若应用允许客户端提交任意 userId，再把它直接当作权限过滤主体，正确的 ACL 也可能被绕过。应用应从已验证的登录上下文取得主体，检查所调用 API 支持的身份方式，避免为了查询方便改用没有对应用户边界的高权限身份。服务内部暂存候选 ID 和把候选正文返回应用是不同边界；某种算法可以在受信搜索服务里计算未授权候选，不等于它们可以进入生成模型的上下文。本文不推断 Microsoft Search 实际怎样处理这些内部候选。

## 从检索权限延伸到执行权限

读权限正确，仍不代表 Agent 执行动作安全。一个用户获准读 F1，不能因此授权工具删除整个目录、替另一人访问 F2 或把正文发送到任意域名。检索应使用真实用户身份及其权限；工具层应限制操作、对象和网络目的地，并在下游再次授权。OWASP 将功能过多、权限过大和自主行动过多区分为风险来源，建议最小权限、用户上下文、高影响动作人工批准以及下游完整授权检查。[OWASP Excessive Agency](https://genai.owasp.org/llmrisk/llm062025-excessive-agency/)

预工具审批（pre-tool approval）让人在调用前审查动作，属于控制流程；内核或容器约束限制进程实际能访问什么，属于执行边界。审批“写 F1”之后若通用 shell 仍可读取其他目录并联网，弹窗没有变成文件系统隔离。人在环（Human in the Loop，HITL）适合审批具体动作与范围，但不能替代每次实际请求的权限检查。审计应保存身份、目标、操作、批准依据和结果，而不是把所有正文与 secret 原样写进日志。

本地与云端的威胁模型（threat model）都要写清攻击者和控制权。本机 Agent 可能受到同账户程序、设备失窃或管理员影响；云服务需要考虑服务操作者、租户隔离、身份配置和日志保留。管理员权限也不等于自动获得所有秘密：可读范围取决于密钥持有者、系统权限和隔离设计；同时不能只因“本地”就断言管理员无法读取运行时明文。

以下是设计建议：给每种数据比较控制者、identity、retention、egress 和 compliance，即谁运行系统、以谁的身份、保存多久、发往哪里、适用何种合规控制，再决定部署。本地加密解决的是特定静态存储风险，还要问谁持有解密 key、哪个进程能申请解密。凭证代理（credential proxy）可以把 token 保存在受控服务里，只允许 Agent 请求指定范围的操作；若 proxy 接受任意目标 URL 或过宽身份，它仍可能成为越权通道。把密钥放在“云”或“本地”都不能代替这些约束。

Graph ACL、检索过滤、工具审批和 sandbox 因而各自承担一部分责任：ACL 提供授权状态，检索服务据此控制内容可见，执行系统限制动作，审批与审计提供人工控制和追溯。连接器权限可继续与[MCP](#/lesson/mcp)、[Agent 安全](#/lesson/agent-security)、[混合检索](#/lesson/hybrid-search)联读。

<details>
<summary>面试怎么回答</summary>

约一分钟：企业 Agent 的权限要同时管数据读取和工具执行。Graph Connector 用 externalItem ACL 表达用户、Entra 组或 externalGroup 的允许与拒绝，deny 优先。外部组把源系统权限接到 Entra 身份，必须同步成员变化和撤权。Microsoft Search 的内部过滤阶段不能从 ACL 契约推断。Azure AI Search 明确提供三种向量过滤模式：preFilter 在片内遍历时过滤，postFilter 在片内候选之后过滤，strictPostFilter 在全局 TopK 之后过滤。后两种可能漏掉授权相关文件，但正确过滤后不必泄露。过滤方式也无法修复过期 ACL。执行层还需最小权限、下游授权、隔离、具体审批与审计。

**追问一：为什么不能把组成员全部复制到文件 ACL？**

可以形成某时刻的展开结果，但每次成员变化都可能更新大量文件，漏更新会形成不同步授权。externalGroup 把文件对组的引用和组 membership 分开。它降低更新扇出，却仍需可靠同步与对账。

**追问二：postFilter 返回少了，就是权限实现不安全吗？**

数量少通常说明候选截断带来召回损失。安全性取决于权限判断是否正确、是否在内容流向用户或模型前执行、失败是否放行。既能有安全但召回差的系统，也能有使用 preFilter 却因旧 ACL 泄露的系统。

**追问三：权限更新是否必须触发全量 crawl？**

不是。Graph 允许只更新 acl，而且该 collection 会整体覆盖。文件权限变化更新对应 item，组成员变化同步 membership。全量对账可补漏，但增量事件能否可靠覆盖权限事件要看源和实现。

**追问四：本地加密和每次弹窗能否保证工具不会泄密？**

需要追问密钥与进程权限。运行时能解密的进程仍可能读明文，审批也不约束通用 shell 的其他能力。应同时限制工具参数、目标资源、网络出口和下游身份，并验证拒绝路径。

</details>

## 小练习

使用向量表，仍取 k=3，把 B1 从未授权改成授权，其他项不变。分别算 preFilter、postFilter、strictPostFilter 的输出。再假设 A4 的权限刚被撤销但索引仍显示授权：哪种模式能仅靠改变过滤阶段保证不返回 A4？

<details>
<summary>参考思路</summary>

preFilter 仍选 A3、A4、A5。postFilter 在 A 片剩 A3，在 B 片剩 B1、B2，汇总 A3、B1、B2；strictPostFilter 的未过滤全局 Top3 仍是 A1、A2、A3，最后只有 A3。普通 post 与 strict post 此时的数量和内容不同。A4 的旧授权问题没有一种阶段能普遍修复；本例后两者碰巧未召回它，也不是权限保证。需要同步撤权并验证当前查询的有效授权状态。

</details>
