> **项目状态**：Active · **项目类型**：正式产品 · **开发分支**：develop · **稳定分支**：main

# Resume Tailor — JD 定制化简历工作台

贴入目标岗位 JD，AI 把它拆解成「这个岗位实际在做什么、筛简历的人在看什么」，然后对你的简历给出**分级的修改策略**——差距大就大改重构（删无关经历、从素材库扶正相关经历），差距小才做关键词措辞微调。简历数据全程留在你自己浏览器里。

## 它解决什么问题

海投时代，一份通用简历打所有岗位是最低效的做法；但手动为每个 JD 定制又太贵。Resume Tailor 把「定制」变成一条可确认的流水线：

1. **贴 JD、选 base 简历** → 开始分析
2. **岗位实际在做什么** — JD 五层解构：岗位定性（职位族/级别/工作性质）→ 团队画像与误读风险 → 行话速成 → 任务结构（建设/探索/维护三类）与话术翻译 → 典型工作日 → 要求排序（机器筛规则/团队痛感）→ 加分项情报 → 交互画像（协作对象与强度）
3. **岗位匹配度判断** — A/B/C/D 定性分档（先判方向族、再看核心经历重合度）+ 硬门槛逐条 met/partial/gap 判定与证据引用
4. **逐条确认修改** — 修改策略分级（措辞微调 / 换主线 / 大改重构）+ 结构动作（删无关、补素材）与措辞动作分开呈现，diff 视图可逐条编辑、勾选应用
5. **完成** — 应用结果、核心词覆盖验证、简历预览、记录投递

**投后闭环**：投递追踪管线（已投递 → 初筛 → 一面 → 二面 → HR → offer/挂），每条投递按下一场轮次生成面试准备——项目下钻卡（结果/过程/反思三层 + 追问预判）、该轮高频题骨架、gap 三段式防御、反问清单、前一天 checklist。

## 与同类工具的差异

| | 通用简历优化工具（简历宝等） | ChatGPT 直接贴 JD | Resume Tailor |
|---|---|---|---|
| JD 理解深度 | 关键词匹配 | 一次性对话，无结构 | 五层解构 + 岗位定性，先翻译 JD 再改简历 |
| 修改策略 | 措辞润色 | 措辞润色 | **分级策略**：差距大时敢删整段经历、从素材库扶正新主线 |
| 素材来源 | 只看当前简历 | 只看当前简历 | 素材库 + 隐藏经历池（未上简历的真实经历），gap 判定和补强都计入 |
| 修改确认 | 一次性生成全文 | 一次性生成全文 | diff 逐条确认、可编辑、可拒绝重写 |
| 投后 | 无 | 无 | 投递追踪 + 按轮次面试 prep |
| 数据隐私 | 云端存储 | 云端对话 | 简历存浏览器 IndexedDB，服务端零数据库 |

## 快速开始

```bash
git clone <repo-url> && cd resume-tailor
npm install
npm run start          # http://localhost:3000
```

在「设置」页填一个 OpenAI 兼容的模型服务即可开始（API 地址 / 模型名 / Key，存在浏览器本地）：

- **DeepSeek**：`https://api.deepseek.com/v1` + `deepseek-chat`（自动降级 json_object 模式）
- **OpenAI / 其他兼容网关**（如公司内部 One-API）：填 base URL 即可，支持 `json_schema` 结构化输出的模型效果最佳

## 本地运行与环境说明（供人类与 AI 助手阅读）

**运行形态**：前端是 `public/` 下的原生 JS 单页（零构建）；后端是 Express 服务（`src/server.ts`），用 tsx 直接跑 TS 源码，**没有编译/构建步骤**。

**API Key 配置（最容易踩的坑）**：
- 本项目**不读取任何 `.env` / 环境变量来配置 LLM**。`package.json` 里的 `dotenv` 是历史遗留依赖，代码从未 import；仓库根目录如出现 `.env`，只是开发者个人笔记，程序不读取。
- 所有 LLM 配置都在**网页内的「设置」视图**完成，共三个字段：API 地址（OpenAI 兼容 base URL）、模型名、API Key。
- 配置保存在**浏览器 IndexedDB**；每次请求由前端通过 `x-llm-key` / `x-llm-base-url` / `x-llm-model` 请求头传给本地服务端，服务端原样转发给 LLM，**服务端不持久化任何 key**。
- 验证配置：设置页的「测试连接」按钮（`POST /api/llm-ping`），能返回模型回复即成功。

**事实速查**（AI agent 可直接使用）：

| 事项 | 值 |
|---|---|
| 环境要求 | Node.js ≥ 20 |
| 启动命令 | `npm run start`（等价 `tsx src/server.ts`） |
| 默认端口 | 3000（`PORT` 环境变量可覆盖——这是代码读取的唯一 env） |
| 构建/编译 | 无 |
| LLM 配置位置 | 浏览器「设置」页 → 存 IndexedDB；不在 env 或配置文件里 |
| 用户数据位置 | 全部在浏览器 IndexedDB（简历/素材/投递记录/设置），设置页支持导出导入 JSON 备份 |
| 服务端职责 | 托管 `public/` 静态文件 + 转发 `/api/*` 到 LLM，零数据库 |
| 云端部署 | Vercel（`api/index.ts` 与本地同一 app，`vercel.json` 已配置） |

## 架构

```
public/           前端（原生 JS 单页应用，零构建）
  index.html      页面结构与分步向导骨架
  app.js          渲染与交互逻辑（~2000 行）
  style.css       全部样式
src/
  server.ts       Express 服务：/api/analyze、/api/editplan、/api/prep 等端点
  analyze.ts      LLM 结构化输出层（Zod schema → json_schema strict / json_object 降级）
  prompts.ts      全部 prompt：分析/解构/编辑方案/面试 prep/简历解析/素材挖掘
  apply.ts        HTML 简历的文本节点级编辑应用与关键词覆盖计算
  structuredApply.ts  结构化简历（PDF 链路）的下标级编辑应用
api/index.ts      Vercel 函数入口（与本地 server.ts 同一 app）
```

**核心设计**：
- **LLM 只做判定，不做算术**——匹配度是 A/B/C/D 定性档（方向族 → 核心经历重合度 → 机器筛否决），不编数字分数
- **prompt 即产品**——JD 解构五层、编辑策略分级、素材取材铁律全部在 `prompts.ts`，可读可调
- **strict schema 自愈**——Zod 4 转 JSON Schema 后递归补全 `required`/`additionalProperties`，兼容 DeepSeek/OpenAI 的 strict 校验
- **PDF 简历链路**——pdf.js 坐标分行重建文本（双栏简历行序不乱）→ LLM 结构化 → 大厂式核对表格（漏的内容「+」手动补填）
- **零后端存储**——简历/素材/投递记录全在浏览器 IndexedDB，服务端只做 LLM 转发

## 部署

Vercel（Hobby 计划可直接部署，`vercel.json` 已配置）：

```bash
npx vercel
```

注意 Hobby 计划函数 55s 超时上限：完整分析在慢模型上可能超时，重试或换快模型即可。

## 技术栈

TypeScript · Express · Zod · 原生 JS/IndexedDB · pdf.js · pdf-lib（导出 PDF）

## License

MIT
