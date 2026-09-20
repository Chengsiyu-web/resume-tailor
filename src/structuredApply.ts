import type { StructuredResume, StructuredEdit } from "./analyze.js";
import { computeKeywordCoverage } from "./apply.js";

export interface AppliedStructuredEdit extends StructuredEdit {
  status: "applied" | "skipped";
  note?: string;
}

export interface StructuredApplyResult {
  resume: StructuredResume;
  results: AppliedStructuredEdit[];
  appliedCount: number;
  skippedCount: number;
  keywordCoverage: { keyword: string; category: string; covered: boolean }[];
}

/** 结构化简历渲染成纯文本（供分析/关键词覆盖用，替代 HTML 剥标签后的文本）。 */
export function structuredResumeToText(resume: StructuredResume): string {
  const lines: string[] = [];
  if (resume.name) lines.push(resume.name);
  const contactBits = [resume.contact?.email, resume.contact?.phone, ...(resume.contact?.links ?? [])].filter(Boolean);
  if (contactBits.length) lines.push(contactBits.join(" · "));
  if (resume.summary) lines.push(resume.summary);
  for (const e of resume.education) {
    lines.push(`教育：${e.school}${e.degree ? " · " + e.degree : ""}${e.major ? " · " + e.major : ""}${e.period ? "（" + e.period + "）" : ""}`);
  }
  const section = (label: string, arr: { org?: string; role?: string; name?: string; period?: string; bullets: string[]; tags: string[] }[]) => {
    for (const x of arr) {
      const title = x.org ?? x.name ?? "";
      lines.push(`${label}：${title}${x.role ? " · " + x.role : ""}${x.period ? "（" + x.period + "）" : ""}`);
      for (const b of x.bullets) lines.push("- " + b);
      if (x.tags?.length) lines.push("标签：" + x.tags.join(" / "));
    }
  };
  section("经历", resume.experiences);
  section("项目", resume.projects);
  if (resume.skills) {
    if (Array.isArray(resume.skills)) {
      lines.push("技能：" + resume.skills.join(" / "));
    } else if (typeof resume.skills === "object" && Array.isArray((resume.skills as { groups?: unknown }).groups)) {
      for (const g of (resume.skills as { groups: { label: string; items: string[] }[] }).groups) {
        lines.push(`技能·${g.label}：${g.items.join(" / ")}`);
      }
    }
  }
  if (resume.honors.length) lines.push("荣誉：" + resume.honors.join("；"));
  return lines.join("\n");
}

function targetSection(resume: StructuredResume, section: StructuredEdit["section"]): unknown[] | null {
  switch (section) {
    case "experiences": return resume.experiences;
    case "projects": return resume.projects;
    case "education": return resume.education;
    default: return null;
  }
}

/**
 * 纯转换：对结构化简历应用编辑指令（按下标定位，确定性匹配）。
 * 索引越界或结构不符 → 该条 skipped 带备注，绝不损坏原 JSON。
 */
export function applyStructuredEdits(args: {
  resume: StructuredResume;
  edits: StructuredEdit[];
  keywords?: { core: string[]; plus: string[] };
}): StructuredApplyResult {
  const resume: StructuredResume = JSON.parse(JSON.stringify(args.resume));
  const results: AppliedStructuredEdit[] = [];

  for (const edit of args.edits) {
    const fail = (note: string): AppliedStructuredEdit => ({ ...edit, status: "skipped", note });

    // summary 是独立字段，其余走数组下标
    if (edit.section === "summary") {
      if (edit.op !== "replaceField" || (edit.field && edit.field !== "summary")) {
        results.push(fail("summary 只支持 replaceField(field=summary)"));
        continue;
      }
      edit.currentText = edit.currentText || resume.summary || "";
      resume.summary = edit.newText;
      results.push({ ...edit, status: "applied" });
      continue;
    }

    if (edit.section === "skills") {
      // 技能区以字符串数组形式重排/重写：newText 为「a / b / c」序列
      const items = edit.newText.split(/[\/、,，]/).map((s) => s.trim()).filter(Boolean);
      if (edit.op === "replaceField") {
        resume.skills = items;
        results.push({ ...edit, status: "applied" });
      } else {
        results.push(fail("skills 区只支持 replaceField（newText 为斜杠分隔的技能序列）"));
      }
      continue;
    }

    const arr = targetSection(resume, edit.section);
    if (!arr) { results.push(fail("未知 section")); continue; }
    const target = arr[edit.expIndex] as { bullets?: string[]; tags?: string[]; org?: string; role?: string; period?: string } | undefined;
    if (!target) { results.push(fail(`expIndex ${edit.expIndex} 超出范围（该区共 ${arr.length} 段）`)); continue; }

    if (edit.op === "removeExperience") {
      arr.splice(edit.expIndex, 1);
      results.push({ ...edit, status: "applied" });
      continue;
    }

    if (edit.op === "replaceField") {
      const field = (edit.field || "role") as "org" | "role" | "period";
      if (!(field in target)) { results.push(fail(`字段 ${field} 不存在`)); continue; }
      (target as Record<string, string>)[field] = edit.newText;
      results.push({ ...edit, status: "applied" });
      continue;
    }

    if (edit.op === "reorderTags") {
      if (!edit.newTags) { results.push(fail("reorderTags 需要 newTags")); continue; }
      target.tags = edit.newTags;
      results.push({ ...edit, status: "applied" });
      continue;
    }

    // bullet 级操作
    const bullets = target.bullets ?? (target.bullets = []);
    if (edit.op === "insertBulletAfter") {
      bullets.splice((edit.bulletIndex ?? -1) + 1, 0, edit.newText);
      results.push({ ...edit, status: "applied" });
      continue;
    }
    const bi = edit.bulletIndex;
    if (typeof bi !== "number" || bi < 0 || bi >= bullets.length) {
      results.push(fail(`bulletIndex ${bi} 超出范围（该段共 ${bullets.length} 条）`));
      continue;
    }
    if (edit.op === "replaceBullet") {
      bullets[bi] = edit.newText;
      results.push({ ...edit, status: "applied" });
    } else if (edit.op === "removeBullet") {
      bullets.splice(bi, 1);
      results.push({ ...edit, status: "applied" });
    } else {
      results.push(fail(`不支持的操作 ${edit.op}`));
    }
  }

  const text = structuredResumeToText(resume);
  return {
    resume,
    results,
    appliedCount: results.filter((r) => r.status === "applied").length,
    skippedCount: results.filter((r) => r.status === "skipped").length,
    keywordCoverage: args.keywords
      ? computeKeywordCoverage(text, args.keywords)
      : computeKeywordCoverage(text, { core: [], plus: [] }),
  };
}
