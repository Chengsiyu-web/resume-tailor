import express from "express";
import * as path from "path";
import {
  analyzeResume, generateEditPlan, generateInterviewPrep, refineEdit, llmPing,
  readLlmCredentials, AnalysisError, AnalysisResultSchema,
  parseResumeText, generateStructuredEditPlan, seedMaterialCards,
  StructuredResumeSchema,
} from "./analyze.js";
import { applyEdits, validateEdits, computeKeywordCoverage } from "./apply.js";
import { applyStructuredEdits } from "./structuredApply.js";
import type { EditInstruction, TargetRound, StructuredEdit, StructuredResume } from "./analyze.js";

// 服务商预设：OpenAI 兼容端点。supportsJsonSchema=false 时降级为
// response_format json_object + schema 嵌入 system prompt。
export const PROVIDERS = [
  { id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", defaultModel: "deepseek-chat", supportsJsonSchema: false },
  { id: "dashscope", label: "通义千问", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", defaultModel: "qwen-plus", supportsJsonSchema: false },
  { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", defaultModel: "gpt-4o-mini", supportsJsonSchema: true },
  { id: "custom", label: "自定义（OpenAI 兼容）", baseUrl: "", defaultModel: "", supportsJsonSchema: true },
] as const;

const app = express();
app.use(express.json({ limit: "4mb" }));
app.use(express.static(path.join(process.cwd(), "public")));

const wrap = (fn: (req: express.Request, res: express.Response) => Promise<void> | void) =>
  (req: express.Request, res: express.Response): void => {
    void (async () => {
      try {
        await fn(req, res);
      } catch (error) {
        if (error instanceof AnalysisError) {
          res.status(502).json({ error: error.message });
          return;
        }
        console.error(error);
        res.status(500).json({ error: error instanceof Error ? error.message : "服务内部错误" });
      }
    })();
  };

app.get("/api/meta", (_req, res) => {
  res.json({
    providers: PROVIDERS,
    trackStatus: ["draft", "applied", "screening", "interview1", "interview2", "hr", "offer", "rejected"],
    statusLabels: {
      draft: "草稿", applied: "已投递", screening: "初筛/笔试", interview1: "一面",
      interview2: "二面", hr: "HR面", offer: "Offer", rejected: "挂了",
    },
  });
});

app.post("/api/llm-ping", wrap(async (req, res) => {
  const llm = readLlmCredentials(req.headers, undefined);
  await llmPing(llm);
  res.json({ ok: true });
}));

app.post("/api/analyze", wrap(async (req, res) => {
  const { jdText, resumeHtml, materials = "", hiddenPool = "" } = req.body ?? {};
  if (!jdText?.trim() || !resumeHtml?.trim()) {
    res.status(400).json({ error: "缺少 jdText 或 resumeHtml" });
    return;
  }
  const llm = readLlmCredentials(req.headers, undefined);
  const result = await analyzeResume({ llm, jdText, resumeHtml, materials, hiddenPool });
  // 关键词现状：对照请求体里的简历原文逐词算命中，供「要求 VS 现状」展示
  res.json({
    ...result,
    keywordStatus: computeKeywordCoverage(resumeHtml, {
      core: result.screening.coreKeywords,
      plus: result.screening.plusKeywords,
    }),
  });
}));

app.post("/api/editplan", wrap(async (req, res) => {
  const { jdText, resumeHtml, materials = "", hiddenPool = "", screening } = req.body ?? {};
  if (!jdText?.trim() || !resumeHtml?.trim() || !screening) {
    res.status(400).json({ error: "缺少 jdText、resumeHtml 或 screening" });
    return;
  }
  const llm = readLlmCredentials(req.headers, undefined);
  const editPlan = await generateEditPlan({
    llm, jdText, resumeHtml, materials, hiddenPool,
    screening: { ...AnalysisResultSchema.shape.screening.parse(screening), jobFamily: screening.jobFamily },
  });
  res.json({ editPlan });
}));

app.post("/api/refine-edit", wrap(async (req, res) => {
  const { jdText, edit, requirement } = req.body ?? {};
  if (!jdText?.trim() || !edit?.oldText || !requirement?.trim()) {
    res.status(400).json({ error: "缺少 jdText、edit 或 requirement" });
    return;
  }
  const llm = readLlmCredentials(req.headers, undefined);
  const refined = await refineEdit({ llm, jdText, edit, requirement });
  res.json(refined);
}));

app.post("/api/apply-edits", (req, res) => {
  const { resumeHtml, edits, keywords } = req.body ?? {};
  if (!resumeHtml || !Array.isArray(edits) || edits.length === 0) {
    res.status(400).json({ error: "缺少 resumeHtml 或 edits" });
    return;
  }
  try {
    const result = applyEdits({
      resumeHtml,
      edits: edits as EditInstruction[],
      keywords,
    });
    res.json(result);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error instanceof Error ? error.message : "应用失败" });
  }
});

app.post("/api/validate-edits", (req, res) => {
  const { resumeHtml, edits } = req.body ?? {};
  if (!resumeHtml || !Array.isArray(edits)) {
    res.status(400).json({ error: "缺少 resumeHtml 或 edits" });
    return;
  }
  try {
    res.json({ results: validateEdits(resumeHtml, edits as EditInstruction[]) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error instanceof Error ? error.message : "校验失败" });
  }
});

app.post("/api/prep", wrap(async (req, res) => {
  const { jdText, resumeHtml, materials = "", targetRound, analysisSnapshot } = req.body ?? {};
  if (!jdText?.trim() || !resumeHtml?.trim()) {
    res.status(400).json({ error: "缺少 jdText 或 resumeHtml" });
    return;
  }
  if (targetRound && !["interview1", "interview2", "hr"].includes(targetRound)) {
    res.status(400).json({ error: "targetRound 必须是 interview1/interview2/hr" });
    return;
  }
  const llm = readLlmCredentials(req.headers, undefined);
  const prep = await generateInterviewPrep({
    llm,
    jdText,
    resumeHtml,
    materials,
    targetRound: (targetRound as TargetRound) || "interview1",
    analysisSnapshot,
  });
  res.json(prep);
}));

app.post("/api/parse-resume", wrap(async (req, res) => {
  const { resumeText } = req.body ?? {};
  if (!resumeText?.trim()) {
    res.status(400).json({ error: "缺少 resumeText" });
    return;
  }
  if (resumeText.length > 15000) {
    res.status(400).json({ error: "简历文本过长（>15k 字符），请精简后重试" });
    return;
  }
  const llm = readLlmCredentials(req.headers, undefined);
  const resume = await parseResumeText({ llm, resumeText });
  res.json({ resume });
}));

app.post("/api/seed-materials", wrap(async (req, res) => {
  const { resumeText, hint } = req.body ?? {};
  if (!resumeText?.trim()) {
    res.status(400).json({ error: "缺少 resumeText" });
    return;
  }
  const llm = readLlmCredentials(req.headers, undefined);
  const cards = await seedMaterialCards({ llm, resumeText, hint });
  res.json({ cards });
}));

app.post("/api/editplan-structured", wrap(async (req, res) => {
  const { jdText, resume, materials = "", hiddenPool = "", screening } = req.body ?? {};
  if (!jdText?.trim() || !resume) {
    res.status(400).json({ error: "缺少 jdText 或 resume" });
    return;
  }
  const llm = readLlmCredentials(req.headers, undefined);
  const parsedResume = StructuredResumeSchema.parse(resume) as StructuredResume;
  const editPlan = await generateStructuredEditPlan({
    llm,
    jdText,
    resume: parsedResume,
    materials,
    hiddenPool,
    screening: screening ? { ...AnalysisResultSchema.shape.screening.parse(screening), jobFamily: screening.jobFamily } : { verdict: undefined, hardRequirements: [], plusFactors: [], coreKeywords: [], plusKeywords: [], narrativeShift: "" } as never,
  });
  res.json({ editPlan });
}));

app.post("/api/apply-structured", (req, res) => {
  const { resume, edits, keywords } = req.body ?? {};
  if (!resume || !Array.isArray(edits) || edits.length === 0) {
    res.status(400).json({ error: "缺少 resume 或 edits" });
    return;
  }
  try {
    const parsed = StructuredResumeSchema.parse(resume) as StructuredResume;
    const result = applyStructuredEdits({
      resume: parsed,
      edits: edits as StructuredEdit[],
      keywords,
    });
    res.json(result);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error instanceof Error ? error.message : "应用失败" });
  }
});

export default app;

// 本地直接运行时监听端口；Vercel 上作为函数导入时不监听
if (process.env.VERCEL !== "1") {
  const PORT = Number(process.env.PORT) || 3000;
  app.listen(PORT, () => {
    console.log(`resume-tailor 已启动: http://localhost:${PORT}`);
  });
}
