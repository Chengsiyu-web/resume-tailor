import * as cheerio from "cheerio";
import type { AnyNode, Text } from "domhandler";
import type { EditInstruction } from "./analyze.js";

export interface AppliedEdit extends EditInstruction {
  status: "applied" | "skipped";
  note?: string;
}

export interface ApplyResult {
  html: string;
  results: AppliedEdit[];
  appliedCount: number;
  skippedCount: number;
  keywordCoverage: {
    keyword: string;
    category: string;
    covered: boolean;
  }[];
}

/**
 * 验证编辑指令的 oldText 是否能在简历中命中（用于前端"应用前"校验，不落盘）。
 */
export function validateEdits(html: string, edits: EditInstruction[]): AppliedEdit[] {
  const $ = cheerio.load(html);
  return edits.map((edit) => {
    const match = locateEdit($, edit);
    return {
      ...edit,
      status: match ? "applied" : "skipped",
      note: match ? undefined : "oldText 在简历中找不到逐字匹配",
    };
  });
}

interface LocatedMatch {
  nodes: { node: AnyNode; start: number; end: number }[];
  crossTag: boolean;
}

/**
 * 定位一条编辑指令的 oldText。
 * 返回覆盖到的文本节点列表及每个节点内的覆盖区间（绝对字符坐标转节点内坐标）。
 * 策略：
 *   1. 单个文本节点内完整包含 oldText（格式无损）
 *   2. 跨连续文本节点拼接后命中（替换区间内的内联标签会被清空，报告为 cross-tag）
 *   3. 空白归一化后重试 1/2
 */
function locateEdit($: cheerio.CheerioAPI, edit: EditInstruction): LocatedMatch | null {
  const textNodes: { node: AnyNode; text: string }[] = [];
  const walker = (node: AnyNode) => {
    if (node.type === "text") {
      textNodes.push({ node, text: (node as Text).data });
    } else if (node.type === "tag" && !(node as unknown as { tagName: string }).tagName.match(/^(script|style)$/i)) {
      for (const child of node.children ?? []) walker(child);
    }
  };
  for (const child of $("html")[0]?.children ?? []) walker(child);
  if (textNodes.length === 0) return null;

  const attempts: { normalize: boolean }[] = [{ normalize: false }, { normalize: true }];
  for (const { normalize } of attempts) {
    const nodes = normalize
      ? textNodes.map((t) => ({ node: t.node, text: t.text.replace(/\s+/g, " ") }))
      : textNodes;
    const flat = nodes.map((n) => n.text).join("");
    const oldText = normalize ? edit.oldText.replace(/\s+/g, " ") : edit.oldText;
    const idx = flat.indexOf(oldText);
    if (idx === -1) continue;
    const end = idx + oldText.length;

    // 把 [idx, end) 区间映射回各文本节点
    const covered: { node: AnyNode; start: number; end: number }[] = [];
    let offset = 0;
    for (const n of nodes) {
      const nodeStart = offset;
      const nodeEnd = offset + n.text.length;
      if (nodeEnd > idx && nodeStart < end) {
        covered.push({
          node: n.node,
          start: Math.max(idx, nodeStart) - nodeStart,
          end: Math.min(end, nodeEnd) - nodeStart,
        });
      }
      offset = nodeEnd;
      if (offset >= end) break;
    }
    if (covered.length > 0) {
      return { nodes: covered, crossTag: covered.length > 1 };
    }
  }
  return null;
}

function applyEdit($: cheerio.CheerioAPI, edit: EditInstruction): AppliedEdit {
  const match = locateEdit($, edit);
  if (!match) {
    return { ...edit, status: "skipped", note: "oldText 在简历中找不到逐字匹配，已跳过（未做任何模糊改动）" };
  }
  const first = match.nodes[0];
  const raw = (first.node as Text).data;
  const prefix = raw.slice(0, first.start);
  // 替换区间的全部文本进入第一个节点，其余覆盖节点清空覆盖部分（标签保留但置空）
  (first.node as Text).data = prefix + edit.newText + raw.slice(first.end);
  for (const rest of match.nodes.slice(1)) {
    const r = (rest.node as Text).data;
    (rest.node as Text).data = r.slice(0, rest.start) + r.slice(rest.end);
  }
  return {
    ...edit,
    status: "applied",
    note: match.crossTag ? "跨标签替换：替换区间内原有内联样式已并入纯文本" : undefined,
  };
}

/**
 * 对任意 HTML 文本计算关键词命中（应用后验证与「要求 VS 现状」对照共用）。
 */
export function computeKeywordCoverage(html: string, keywords: { core: string[]; plus: string[] }) {
  const textOnly = html.replace(/<[^>]+>/g, " ");
  const check = (list: string[], category: string) =>
    list.map((keyword) => {
      const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return { keyword, category, covered: new RegExp(escaped).test(textOnly) };
    });
  return [...check(keywords.core, "core"), ...check(keywords.plus, "plus")];
}

/**
 * 纯转换：对简历 HTML 应用编辑指令，返回新 HTML 与逐条结果。
 * 落盘（保存为新版本/覆盖）由客户端在自己浏览器里决定。
 */
export function applyEdits(args: {
  resumeHtml: string;
  edits: EditInstruction[];
  keywords?: { core: string[]; plus: string[] };
}): ApplyResult {
  const $ = cheerio.load(args.resumeHtml);
  const results = args.edits.map((edit) => applyEdit($, edit));
  const newHtml = $.html();

  return {
    html: newHtml,
    results,
    appliedCount: results.filter((r) => r.status === "applied").length,
    skippedCount: results.filter((r) => r.status === "skipped").length,
    keywordCoverage: args.keywords
      ? computeKeywordCoverage(newHtml, args.keywords)
      : computeKeywordCoverage(newHtml, { core: [], plus: [] }),
  };
}
