#!/usr/bin/env node
// 一次性导出本人数据为 my-data.json（导入新前端的 设置 → 数据 → 导入 JSON）
// 用法：node scripts/export-my-data.mjs
import * as fs from "fs";
import * as path from "path";

const root = process.cwd();
const resumesDir = path.join(root, "resumes");
const materialsFile = path.join(root, "materials", "素材库.md");
const hiddenPoolFile = path.join(root, "materials", "隐藏经历.md");
const dataFile = path.join(root, "data", "applications.json");

const read = (p) => fs.existsSync(p) ? fs.readFileSync(p, "utf-8") : "";

const resumes = fs.existsSync(resumesDir)
  ? fs.readdirSync(resumesDir).filter((f) => f.endsWith(".html")).map((f) => {
      const name = f.replace(/\.html$/, "");
      const html = fs.readFileSync(path.join(resumesDir, f), "utf-8");
      return {
        id: "r-" + Buffer.from(name).toString("base64url").slice(0, 12),
        name,
        html,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    })
  : [];

let applications = [];
try {
  applications = JSON.parse(read(dataFile)).map((a) => ({
    ...a,
    resumeId: a.resumeFile
      ? "r-" + Buffer.from(a.resumeFile.replace(/\.html$/, "")).toString("base64url").slice(0, 12)
      : undefined,
    resumeName: a.resumeFile?.replace(/\.html$/, ""),
  }));
} catch { /* 无投递数据 */ }

const out = {
  version: 1,
  exportedAt: new Date().toISOString(),
  resumes,
  applications,
  materials: [
    { key: "materials", text: read(materialsFile) },
    { key: "hiddenPool", text: read(hiddenPoolFile) },
  ],
  settings: [],
};

const outFile = path.join(process.cwd(), "my-data.json");
fs.writeFileSync(outFile, JSON.stringify(out, null, 2), "utf-8");
console.log(`已导出：${outFile}`);
console.log(`简历 ${resumes.length} 份 · 投递 ${applications.length} 条`);
