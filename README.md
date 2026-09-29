# 知行图谱 · Agent Learning Atlas

从 LLM 请求、Agent 工程、RAG 和项目面试，逐步进入模型与训练研究。

[阅读站点](https://jiuchenm.github.io/agent-learning-atlas/)

这是公开课程版本，包含 48 篇文章、8 个阶段与专题。文章保留原始证据链接与核验日期。新课程需要加入显式发布清单。

## 开发与部署

需要 Node.js 22 或更新版本。执行 `npm ci`、`npm test`、`npm run build`。推送 main 后，GitHub Actions 构建并部署 Pages；Settings → Pages 的 Source 选择 GitHub Actions。

`npm run dev` 可在本地预览。hash 路由支持直接打开具体文章，资源路径适配项目子目录。

## 笔记

阅读状态与笔记仅保存在当前网站来源的浏览器存储中，不会提交到 GitHub。localhost 与 Pages 不共享存储，可在“我的笔记”中导出和导入。导入仅接受本站已发布的课程 ID，未收录课程的记录不会导入；迁移前保留完整备份。
