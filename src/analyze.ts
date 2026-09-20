import { z } from "zod";
import {
  ANALYSIS_SYSTEM_PROMPT,
  buildUserPrompt,
  buildEditPlanPrompt,
  buildEditPlanStructuredPrompt,
  EDITPLAN_SYSTEM_PROMPT,
  EDITPLAN_STRUCTURED_SYSTEM_PROMPT,
  PARSE_RESUME_SYSTEM_PROMPT,
  SEED_MATERIALS_SYSTEM_PROMPT,
  REFINE_SYSTEM_PROMPT,
  INTERVIEW_PREP_SYSTEM_PROMPT,
  buildInterviewPrepPrompt,
} from "./prompts.js";

export const EditInstructionSchema = z.object({
  id: z.string().describe("唯一编号，如 e1, e2"),
  section: z.string().describe("简历板块，如 Profile / 美团-AI创作链路 bullet / 技能tag"),
  oldText: z.string().describe("简历 HTML 中逐字存在的可见文本片段，不含标签"),
  newText: z.string().describe("替换后的完整文本（remove 类型为空字符串）"),
  reason: z.string().describe("一句话：为什么这个 JD 需要这条修改"),
  type: z.enum(["verb", "order", "emphasis", "keyword", "tag", "add-from-material", "remove"]),
});

const VerdictSchema = z.object({
  level: z.enum(["值得投", "改后投", "观望", "不建议投"]).describe("综合判定，与 matchGrade 对应：A=值得投 / B=改后投 / C=观望 / D=不建议投"),
  matchGrade: z.enum(["A", "B", "C", "D"]).describe("定性匹配档：A=方向对口且核心经历直接命中，简历基本能用 / B=方向对口但主线或关键词有缺口，改后可投 / C=方向相近但主线不对，需大改重构（换重点经历） / D=方向不符或硬机器筛不过，不建议投"),
  reason: z.string().describe("两句话：最大的匹配点是什么（简历哪段经历/哪个能力直接命中）、最大的缺口是什么（措辞能救 / 需换主线 / 无解）。禁止数字评分"),
});

const RequirementSchema = z.object({
  item: z.string(),
  why: z.string().describe("一句话筛选逻辑"),
  status: z.enum(["met", "partial", "gap"]).describe("对照当前简历的判定：met=有现成证据 / partial=有相近但没点到 / gap=没有。日期区间类要求按包含判断：简历时间落在 JD 区间内即 met"),
  evidence: z.string().describe("met/partial 给简历或素材库中的证据短语（日期类写出区间对照过程）；gap 给一句话结论（如『简历完全未体现』）"),
});

export const AnalysisResultSchema = z.object({
  position: z.object({
    company: z.string().describe("从 JD 原文中识别的招聘公司名，不是简历上求职者现任/曾任的公司"),
    role: z.string().describe("从 JD 原文中识别的岗位名称，不是简历上求职者的现任/曾任职位"),
  }),
  jdInsight: z.object({
    jobClassification: z.object({
      family: z.enum(["技术-后端", "技术-前端", "技术-算法/AI", "技术-数据", "技术-测试/运维", "产品", "运营", "设计", "市场/增长", "销售/商务", "职能（人力/财务/法务）", "其他"])
        .describe("职位族：这个岗位属于哪一类"),
      subFamily: z.string().describe("细分方向，如「AI 应用算法」「B端产品」「内容运营」"),
      seniority: z.enum(["应届/校招", "初级(1-3年)", "中级(3-5年)", "高级(5年+)", "专家/负责人"])
        .describe("岗位级别定位"),
      nature: z.string().describe("工作性质一句话：主要产出物是什么（代码/文档/策略/设计稿/报告）"),
    }).describe("岗位定性：先给用户一个坐标系，再展开细节"),
    mode: z.enum(["translation", "generative"]).describe("翻译模式（JD 信息量大）或生成模式（JD 空泛，从公司业务价值链重建）"),
    teamContext: z.object({
      orgPosition: z.string().describe("这个坑位挂在哪类团队：中台/业务线/职能/创业小队"),
      whoFor: z.string().describe("服务于谁、为什么存在"),
      oneLiner: z.string().describe("一句话结论：这到底是什么岗"),
      misreadRisk: z.string().describe("最容易被误读成什么、误读的代价"),
    }),
    duties: z.array(z.object({
      duty: z.string().describe("JD 原文职责（短语化）"),
      layer: z.enum(["maintenance", "construction", "exploratory"]).describe("维护性/建设性/探索性"),
      timeShare: z.string().describe("这类活占入职时间的比例，如 80%"),
      translation: z.string().describe("话术翻译：具体工作场景，外行能懂；行业术语就地解释或入 jargon 表；「深入理解X」类模糊词要定义化为可自测标准"),
    })),
    jargon: z.array(z.object({
      term: z.string().describe("行业术语"),
      plain: z.string().describe("脱离行业的白话解释，带生活例子"),
      inThisJob: z.string().describe("它在这个岗位具体意味着什么"),
    })).max(6),
    typicalDay: z.string().describe("典型的一天：上午/下午/晚上节奏，2-3 句"),
    requirementsReading: z.object({
      machineFilter: z.string().describe("机器筛简历的硬规则（届别/学历/专业），措辞救不了"),
      priority: z.string().describe("要求排序泄露的团队痛感：宁可弱在哪、不能弱在哪"),
      temperament: z.string().describe("措辞泄露的团队气质"),
    }),
    bonusIntel: z.string().describe("从加分项倒推：团队当前阶段、明年重点、对你意味着什么"),
    interactionMix: z.object({
      nature: z.string().describe("沟通属性定性一句话：如「偏研究型，独立工作为主，沟通少而深」或「强协调型，日常在多方之间对齐」"),
      primary: z.array(z.object({
        who: z.string().describe("高频协作对象的具体职位/团队，如「数据工程团队」「算法负责人」"),
        what: z.string().describe("协作内容一句话：对什么口径、要什么资源、给什么交付"),
      })).min(1).max(3).describe("最经常打交道的对象"),
      occasional: z.array(z.object({
        who: z.string().describe("低频协作对象的具体职位/团队"),
        what: z.string().describe("偶尔沟通的内容与场景"),
      })).max(3).describe("偶尔沟通的对象"),
    }).describe("交互画像：不编百分比，写对象 + 强度"),
    verifyQuestions: z.array(z.string()).describe("面试反问环节可验证的 2-3 个问题").max(3),
  }),
  screening: z.object({
    verdict: VerdictSchema,
    hardRequirements: z.array(RequirementSchema).max(4),
    plusFactors: z.array(RequirementSchema).max(4),
    coreKeywords: z.array(z.string()).describe("HR 10 秒扫描必须命中的词，最多 8 个").max(8),
    plusKeywords: z.array(z.string()).describe("加分词，最多 6 个").max(6),
    narrativeShift: z.string().describe("简历最上方的核心标签应该从什么改成什么，一句话"),
  }),
});

const StrategySchema = z.object({
  level: z.enum(["light_polish", "refocus", "restructure"]).describe("重构幅度：light_polish=方向基本对口，只调措辞重心 / refocus=方向相近但主线不对，需换重点经历+补素材 / restructure=方向差距大，需删整段无关经历+从素材库重建主线"),
  headline: z.string().describe("一句话策略：这份简历要变成什么样才能打这个岗，如「砍掉风控经历，用素材库的SQL项目+美团数据专题扶正成数据方向主线」"),
  cuts: z.array(z.string()).describe("建议整段删除的经历名及理由（light_polish 时为空），如「小红书风控经历——与目标方向无关，删掉为主题让路」"),
  promotions: z.array(z.string()).describe("建议从素材库/隐藏经历池扶正的内容，每条注明来源卡片，如「SQL用户行为分析项目（来源：素材库）」"),
});

const EditPlanResultSchema = z.object({
  strategy: StrategySchema,
  editPlan: z.array(EditInstructionSchema),
});

export type TargetRound = "interview1" | "interview2" | "hr";

const DrillCardSchema = z.object({
  id: z.string().describe("如 c1, c2"),
  bullet: z.string().describe("简历原文 bullet（短语化）"),
  drill: z.object({
    result: z.string().describe("结果层：那个数字的完整说法（口径+对比+含义），可直接说出口"),
    process: z.string().describe("过程层：1-2 个具体动作/决策瞬间，个人贡献与团队边界"),
    reflection: z.string().describe("反思层：如果重做我会 X，因为当时 Y。具体，禁空话"),
  }),
  followUps: z.array(z.object({
    q: z.string().describe("大概率被追问的问题"),
    howToCatch: z.string().describe("怎么接：用素材库里哪条事实/数字接住它"),
  })).max(3),
});

export const InterviewPrepSchema = z.object({
  round: z.enum(["interview1", "interview2", "hr"]).describe("这份 prep 面向的轮次"),
  focus: z.string().describe("这一轮面试官考察什么，一句话"),
  selfIntro: z.object({
    narrative: z.string().describe("叙事主线一句话：为什么我的经历链指向这个岗位"),
    segments: z.array(z.object({
      hook: z.string().describe("这段的钩子（引面试官往下问什么）"),
      points: z.string().describe("这段说什么要点"),
    })).min(2).max(4),
  }),
  drillCards: z.array(DrillCardSchema).min(1).max(7),
  gapDefenses: z.array(z.object({
    gap: z.string().describe("gap 或 partial 的项"),
    script: z.string().describe("三段式：诚实承认 → 可迁移证据 → 学习行动"),
  })),
  likelyQuestions: z.array(z.object({
    q: z.string().describe("这一轮的高频问题"),
    framework: z.string().describe("答题骨架：先说什么后说什么、几段式、每段落点。非逐字稿"),
  })).min(6).max(8),
  counterQuestions: z.array(z.string()).min(3).max(5),
  dayBeforeChecklist: z.array(z.string()).min(5).max(8),
});

export type InterviewPrep = z.infer<typeof InterviewPrepSchema>;

const RefineResultSchema = z.object({
  newText: z.string().describe("按用户要求重写后的完整替换文本"),
  reason: z.string().describe("一句话：这条修改现在为什么成立"),
});

export type AnalysisResult = z.infer<typeof AnalysisResultSchema>;
export type EditInstruction = z.infer<typeof EditInstructionSchema>;

// ---------- 结构化简历（PDF 链路） ----------
export const StructuredResumeSchema = z.object({
  name: z.string().optional().describe("姓名"),
  contact: z.object({
    email: z.string().optional(),
    phone: z.string().optional(),
    links: z.array(z.string()).default([]).describe("个人主页 / GitHub 等"),
  }).default({ links: [] }),
  summary: z.string().optional().describe("个人总结 / 求职意向段"),
  education: z.array(z.object({
    school: z.string(),
    degree: z.string().optional(),
    major: z.string().optional(),
    period: z.string().optional(),
    confidence: z.enum(["high", "low"]).optional().describe("low = 从原文推断，需要用户确认"),
  })).default([]),
  experiences: z.array(z.object({
    org: z.string().describe("公司 / 组织"),
    role: z.string().optional().describe("职位"),
    period: z.string().optional(),
    bullets: z.array(z.string()).default([]).describe("职责与成果条目，尽量保留原文措辞"),
    tags: z.array(z.string()).default([]).describe("经历标签（如 AIGC / Agent）"),
    confidence: z.enum(["high", "low"]).optional(),
  })).default([]),
  projects: z.array(z.object({
    name: z.string(),
    role: z.string().optional(),
    period: z.string().optional(),
    bullets: z.array(z.string()).default([]),
    tags: z.array(z.string()).default([]),
    confidence: z.enum(["high", "low"]).optional(),
  })).default([]),
  skills: z.union([
    z.object({ groups: z.array(z.object({ label: z.string(), items: z.array(z.string()) })) }),
    z.array(z.string()),
  ]).optional(),
  honors: z.array(z.string()).default([]),
});
export type StructuredResume = z.infer<typeof StructuredResumeSchema>;

export const StructuredEditSchema = z.object({
  id: z.string().describe("唯一编号，如 e1, e2"),
  op: z.enum(["replaceBullet", "insertBulletAfter", "removeBullet", "replaceField", "reorderTags", "removeExperience"])
    .describe("replaceField 的 field: org/role/period/summary；reorderTags 重排 tags 数组"),
  section: z.enum(["experiences", "projects", "summary", "skills", "education"]),
  expIndex: z.number().int().min(0).describe("目标段落在 experiences/projects 数组中的下标（从 0 起）；summary/skills 固定填 0"),
  bulletIndex: z.number().int().min(0).optional().describe("目标 bullet 下标；insertBulletAfter 表示插到该条之后"),
  field: z.string().optional().describe("replaceField 时的字段名：org / role / period / summary"),
  currentText: z.string().describe("被改内容的当前原文（仅用于前端 diff 展示，不参与匹配）"),
  newText: z.string().describe("替换后的完整文本（remove 类为空字符串）"),
  newTags: z.array(z.string()).optional().describe("reorderTags 时的新标签序列"),
  reason: z.string().describe("一句话：为什么这个 JD 需要这条修改"),
  type: z.enum(["verb", "order", "emphasis", "keyword", "tag", "add-from-material", "remove"]),
});
export type StructuredEdit = z.infer<typeof StructuredEditSchema>;

const EditPlanStructuredResultSchema = z.object({
  strategy: StrategySchema,
  editPlan: z.array(StructuredEditSchema),
});

// ---------- 素材卡 ----------
export const MaterialCardSchema = z.object({
  type: z.enum(["exp", "trait", "result", "note"]),
  title: z.string().describe("卡片标题：经历卡=组织+角色（例：美团 · 算法实习生 / 班长）；特质卡=特质短语"),
  situation: z.string().optional().describe("经历卡 S：当时的背景"),
  task: z.string().optional().describe("经历卡 T：要解决的问题，一句话"),
  action: z.string().optional().describe("经历卡 A：具体做了什么，动词开头"),
  result: z.string().optional().describe("经历卡 R / 成果卡：结果，有数字给数字和口径"),
  caliber: z.string().optional().describe("成果卡：口径与对比基准"),
  evidence: z.string().optional().describe("特质卡：能证明该特质的一件事"),
  fit: z.string().optional().describe("特质卡：适配的工作环境"),
  whyNotOnResume: z.string().optional().describe("为什么没上简历（例：和现在的方向不符，被裁掉了）"),
  text: z.string().optional().describe("note 卡自由文本"),
  reasonForCandidate: z.string().describe("为什么建议收录这张卡，一句话"),
});

const SeedMaterialsResultSchema = z.object({
  cards: z.array(MaterialCardSchema).max(8),
});
export type MaterialCard = z.infer<typeof MaterialCardSchema>;

export class AnalysisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnalysisError";
  }
}

export interface LlmCredentials {
  baseUrl: string;
  model: string;
  apiKey: string;
  supportsJsonSchema: boolean;
}

export function readLlmCredentials(headers: Record<string, string | string[] | undefined>, fallback: LlmCredentials | undefined): LlmCredentials {
  const apiKey = headerValue(headers, "x-llm-key").trim();
  const baseUrl = headerValue(headers, "x-llm-base-url").trim();
  const model = headerValue(headers, "x-llm-model").trim();
  const supportsJsonSchema = headerValue(headers, "x-llm-json-schema") !== "0";

  if (!apiKey || !/^[\x21-\x7e]+$/.test(apiKey)) {
    throw new AnalysisError("缺少有效的 API Key，请先在「设置」里配置模型服务。");
  }
  if (!baseUrl || !/^https?:\/\//.test(baseUrl)) {
    throw new AnalysisError("缺少有效的 API 地址，请先在「设置」里配置模型服务。");
  }
  if (!model) {
    throw new AnalysisError("缺少模型名称，请先在「设置」里配置模型服务。");
  }
  void fallback;
  return { apiKey, baseUrl: baseUrl.replace(/\/$/, ""), model, supportsJsonSchema };
}

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string {
  const value = headers[name.toLowerCase()] ?? headers[name];
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

/** 共享的结构化输出调用：system + user → json_schema（不支持时降级 json_object）解析。内置一次重试。 */
export async function llmComplete<T>(args: {
  llm: LlmCredentials;
  system: string;
  user: string;
  schemaName: string;
  zodSchema: z.ZodType<T>;
  maxTokens?: number;
}): Promise<T> {
  const { llm } = args;

  // Zod 4 原生导出 JSON Schema，直接交给支持 json_schema 的结构化输出（strict 约束解码）
  const rawSchema = z.toJSONSchema(args.zodSchema) as Record<string, unknown>;
  delete rawSchema.$schema;

  // strict 模式要求：每个对象的 required 必须覆盖全部属性、禁 additionalProperties。
  // Zod 的 optional/default 字段不进 required，DeepSeek/OpenAI 会直接 400，此处递归补全。
  const toStrict = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(toStrict);
    if (node === null || typeof node !== "object") return node;
    const obj = { ...(node as Record<string, unknown>) };
    if (obj.type === "object" && typeof obj.properties === "object" && obj.properties !== null) {
      const keys = Object.keys(obj.properties as Record<string, unknown>);
      obj.required = keys;
      obj.additionalProperties = false;
    }
    for (const [k, v] of Object.entries(obj)) {
      if (k !== "required" && k !== "additionalProperties") obj[k] = toStrict(v);
    }
    return obj;
  };
  const schema = toStrict(rawSchema) as Record<string, unknown>;

  const useJsonSchema = llm.supportsJsonSchema;
  const systemWithSchema = useJsonSchema
    ? args.system
    : `${args.system}\n\n## 输出格式（必须严格遵守）\n\n只输出一个 JSON 对象，不要输出任何其他文字或代码块标记。JSON 必须符合以下 JSON Schema：\n${JSON.stringify(schema)}`;

  const buildBody = (messages: { role: string; content: string }[]) => ({
    model: llm.model,
    max_tokens: args.maxTokens ?? 16000,
    messages,
    ...(useJsonSchema
      ? {
          response_format: {
            type: "json_schema",
            json_schema: { name: args.schemaName, strict: true, schema },
          },
        }
      : { response_format: { type: "json_object" } }),
  });

  const post = async (messages: { role: string; content: string }[]) => {
    let response: Response;
    try {
      response = await fetch(`${llm.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${llm.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(buildBody(messages)),
        // Vercel Hobby 函数 60s 上限，超时前留余量返回友好错误；本地无此限制，放宽到 5 分钟
        signal: AbortSignal.timeout(process.env.VERCEL === "1" ? 55_000 : 300_000),
      });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new AnalysisError("模型请求超时（55 秒），请重试或换更快的模型。");
      }
      throw new AnalysisError(`无法连接模型服务：${error instanceof Error ? error.message : String(error)}`);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      if (response.status === 401) {
        throw new AnalysisError("API Key 无效或已过期，请到「设置」检查。");
      }
      if (response.status === 429) {
        throw new AnalysisError("模型服务限流（请求次数或额度超限），请稍等一分钟再试。");
      }
      throw new AnalysisError(`模型服务错误 ${response.status}: ${text.slice(0, 300)}`);
    }

    const data = await response.json() as {
      choices?: { message?: { content?: string }; finish_reason?: string }[];
    };
    const choice = data.choices?.[0];
    const content = choice?.message?.content;
    if (!content) {
      throw new AnalysisError("模型返回为空，请重试。");
    }
    if (choice?.finish_reason === "length") {
      throw new AnalysisError("模型输出被 max_tokens 截断，JSON 不完整。请在「设置」换输出更长的模型或精简 JD 后重试。");
    }
    return content;
  };

  const content = await post([
    { role: "system", content: systemWithSchema },
    { role: "user", content: args.user },
  ]);

  const parsed = args.zodSchema.safeParse(safeJsonParse(content));
  if (parsed.success) return parsed.data;

  // 校验失败：偶发（模型漏字段 / JSON 外裹了杂质）。自动重试一次。
  const detail = parsed.error.issues
    .slice(0, 5)
    .map((i) => `${i.path.join(".")}: ${i.message}`)
    .join("; ");
  console.error(`[llm] 结构化校验失败（${args.schemaName}）: ${detail}\n[llm] 原始输出前 800 字: ${content.slice(0, 800)}`);

  try {
    const retryContent = await post([
      { role: "system", content: systemWithSchema },
      { role: "user", content: args.user },
      // 把失败输出给回去，点名修好它
      { role: "assistant", content },
      { role: "user", content: "上一次输出未通过 schema 校验：" + detail + "。请修正后重新输出完整 JSON。" },
    ]);
    const retryParsed = args.zodSchema.safeParse(safeJsonParse(retryContent));
    if (retryParsed.success) return retryParsed.data;
    console.error(`[llm] 重试仍失败: ${retryParsed.error.issues.slice(0, 3).map(String).join("; ")}`);
  } catch (retryError) {
    if (retryError instanceof AnalysisError) throw retryError;
    console.error("[llm] 重试请求异常:", retryError);
  }

  throw new AnalysisError(`结构化输出校验失败（${detail}），已自动重试一次仍未通过，请再点一次分析。`);
}

/** 测试 LLM 连通性：一次最小补全。 */
export async function llmPing(llm: LlmCredentials): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${llm.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${llm.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: llm.model,
        max_tokens: 4,
        messages: [{ role: "user", content: "回复两个字：收到" }],
      }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new AnalysisError("连接超时（20 秒），请检查 API 地址是否可达。");
    }
    throw new AnalysisError(`无法连接：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    if (response.status === 401) throw new AnalysisError("API Key 无效或已过期。");
    if (response.status === 404) throw new AnalysisError("接口不存在，请检查 API 地址是否为 OpenAI 兼容的 base URL（一般以 /v1 结尾）。");
    if (response.status === 429) throw new AnalysisError("限流或额度不足。");
    throw new AnalysisError(`模型服务错误 ${response.status}: ${text.slice(0, 200)}`);
  }
}

/**
 * 清洗模型输出的编辑文本：去 HTML 标签、还原常见实体。
 * 编辑匹配按文本节点做，含标签/实体的 oldText 必然匹配失败，清洗能救回不少。
 */
function sanitizeEditText(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'");
}

export async function analyzeResume(args: {
  llm: LlmCredentials;
  jdText: string;
  resumeHtml: string;
  materials: string;
  hiddenPool: string;
}): Promise<AnalysisResult> {
  // 阶段 1：结论先行（verdict + 要求 VS 现状），不含修改方案
  return llmComplete({
    llm: args.llm,
    system: ANALYSIS_SYSTEM_PROMPT,
    user: buildUserPrompt(args),
    schemaName: "analysis_result",
    zodSchema: AnalysisResultSchema,
  });
}

/**
 * 阶段 3：面试准备。只为指定的一轮生成 prep——深度优先于覆盖面。
 */
export async function generateInterviewPrep(args: {
  llm: LlmCredentials;
  jdText: string;
  resumeHtml: string;
  materials: string;
  targetRound: TargetRound;
  analysisSnapshot?: AnalysisResult;
}): Promise<InterviewPrep> {
  const s = args.analysisSnapshot?.screening;
  const insight = args.analysisSnapshot?.jdInsight;
  const analysisSummary = s && insight
    ? [
        `判定：${s.verdict.level}（${s.verdict.matchGrade} 档）——${s.verdict.reason}`,
        `团队画像：${insight.teamContext.oneLiner}`,
        `硬门槛判定：${s.hardRequirements.map((r) => `${r.item}[${r.status}]`).join("；")}`,
        `加分项判定：${s.plusFactors.map((r) => `${r.item}[${r.status}]`).join("；")}`,
        `核心词：${s.coreKeywords.join(" / ")}`,
        `验证假设（可直接作为反问）：${insight.verifyQuestions.join("；")}`,
      ].join("\n")
    : undefined;

  return llmComplete({
    llm: args.llm,
    system: INTERVIEW_PREP_SYSTEM_PROMPT,
    user: buildInterviewPrepPrompt({
      jdText: args.jdText,
      resumeHtml: args.resumeHtml,
      materials: args.materials,
      targetRound: args.targetRound,
      analysisSummary,
    }),
    schemaName: "interview_prep",
    zodSchema: InterviewPrepSchema,
    maxTokens: 16000,
  });
}

/**
 * 阶段 2：用户确认要投之后按需生成修改方案（bullet 级外科手术）。
 * 阶段 1 的 screening 结论作为差距清单注入，此处专注施工。
 */
export async function generateEditPlan(args: {
  llm: LlmCredentials;
  jdText: string;
  resumeHtml: string;
  materials: string;
  hiddenPool: string;
  screening: AnalysisResult["screening"] & { jobFamily?: string };
}): Promise<EditInstruction[]> {
  const result = await llmComplete({
    llm: args.llm,
    system: EDITPLAN_SYSTEM_PROMPT,
    user: buildEditPlanPrompt({
      jdText: args.jdText,
      resumeHtml: args.resumeHtml,
      materials: args.materials,
      hiddenPool: args.hiddenPool,
      screening: args.screening,
    }),
    schemaName: "edit_plan_result",
    zodSchema: EditPlanResultSchema,
    maxTokens: 12000,
  });
  // 服务端兜底清洗：即使模型仍输出标签/实体，也保证 oldText 有机会命中
  return result.editPlan.map((e) => ({
    ...e,
    oldText: sanitizeEditText(e.oldText),
    newText: sanitizeEditText(e.newText),
  }));
}

/**
 * 用户不认同某条修改时，按其要求只重写这一条（保留 oldText 不动，只换 newText）。
 */
export async function refineEdit(args: {  llm: LlmCredentials;
  jdText: string;
  edit: EditInstruction;
  requirement: string;
}): Promise<{ newText: string; reason: string }> {
  const refined = await llmComplete({
    llm: args.llm,
    system: REFINE_SYSTEM_PROMPT,
    user: `## 目标岗位 JD

${args.jdText}

## 待重写的修改条目

${JSON.stringify(args.edit, null, 2)}

## 用户对这条修改的要求

${args.requirement}

请只重写 newText（oldText 原样保留在输出之外，不要改动匹配锚点）。`,
    schemaName: "refine_result",
    zodSchema: RefineResultSchema,
    maxTokens: 2000,
  });
  return {
    newText: sanitizeEditText(refined.newText),
    reason: refined.reason,
  };
}

// ---------- PDF 链路：解析 / 结构化修改方案 / 素材种子 ----------

/** PDF 提取文本 → 结构化简历。只重建文本能支撑的内容，拿不准的字段标 confidence:low。 */
export async function parseResumeText(args: {
  llm: LlmCredentials;
  resumeText: string;
}): Promise<StructuredResume> {
  return llmComplete({
    llm: args.llm,
    system: PARSE_RESUME_SYSTEM_PROMPT,
    user: `## 简历全文（PDF 提取的纯文本，阅读顺序可能有乱）

${args.resumeText}

请重建为结构化简历。条目措辞尽量保留原文；不确定的字段标 confidence 为 low。`,
    schemaName: "structured_resume",
    zodSchema: StructuredResumeSchema,
    maxTokens: 8000,
  });
}

/** 结构化简历的修改方案：指令引用 section+下标，匹配是确定性的，不依赖逐字 oldText。 */
export async function generateStructuredEditPlan(args: {
  llm: LlmCredentials;
  jdText: string;
  resume: StructuredResume;
  materials: string;
  hiddenPool: string;
  screening: AnalysisResult["screening"] & { jobFamily?: string };
}): Promise<StructuredEdit[]> {
  const result = await llmComplete({
    llm: args.llm,
    system: EDITPLAN_STRUCTURED_SYSTEM_PROMPT,
    user: buildEditPlanStructuredPrompt(args),
    schemaName: "edit_plan_structured_result",
    zodSchema: EditPlanStructuredResultSchema,
    maxTokens: 12000,
  });
  return result.editPlan;
}

/** 从简历文本 / 用户提示里挖素材卡：优先简历里没有的经历（班干部、社团、比赛等）。 */
export async function seedMaterialCards(args: {
  llm: LlmCredentials;
  resumeText: string;
  hint?: string;
}): Promise<MaterialCard[]> {
  const result = await llmComplete({
    llm: args.llm,
    system: SEED_MATERIALS_SYSTEM_PROMPT,
    user: `## 简历全文（或自述文本）

${args.resumeText}

${args.hint?.trim() ? `## 用户补充提示

${args.hint}` : ""}

请输出候选素材卡。只摘文本中真实存在的事实，不编造；每张卡用 reasonForCandidate 说清为什么值得收录。`,
    schemaName: "seed_materials_result",
    zodSchema: SeedMaterialsResultSchema,
    maxTokens: 6000,
  });
  return result.cards;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // 兜底：容忍模型在 JSON 外裹了 markdown 代码块
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch { /* fall through */ }
    }
    return undefined;
  }
}
