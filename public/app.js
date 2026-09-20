// 全局错误捕获：把 null reading 这类运行时错误的完整信息显示出来（而不是无声失败）
window.addEventListener("error", (e) => {
  if (e.error && e.error.stack) console.error("[resume-tailor]", e.error);
  const msg = e.message || "未知错误";
  if (window.toast) toast("页面出错：" + msg.slice(0, 80) + "（控制台看完整堆栈）", true);
});
window.addEventListener("unhandledrejection", (e) => {
  const err = e.reason;
  console.error("[resume-tailor rejection]", err);
  if (window.toast && err instanceof Error) toast("异步出错：" + err.message.slice(0, 80), true);
});

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

let currentAnalysis = null;
let applyMode = "new";
let trackApps = [];
let trackFilter = "all";
let trackOpenId = null;
let resumes = [];
let selectedResumeId = null;
let appliedHtml = null;
let appliedResumeName = null;
let lastAppliedResult = null;
let lastAppliedKind = "html";
let appliedStructuredData = null;
let META = null;

const TRACK_STATUSES = ["draft", "applied", "screening", "interview1", "interview2", "hr", "offer", "rejected"];
let STATUS_LABEL = { draft: "草稿", applied: "已投递", screening: "初筛/笔试", interview1: "一面", interview2: "二面", hr: "HR面", offer: "Offer", rejected: "挂了" };

// ---------- IndexedDB ----------
const DB_NAME = "resume-tailor";
const DB_VERSION = 2;
const STORES = ["resumes", "applications", "materials", "settings"];
let db = null;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains("resumes")) d.createObjectStore("resumes", { keyPath: "id" });
      if (!d.objectStoreNames.contains("applications")) d.createObjectStore("applications", { keyPath: "id" });
      if (!d.objectStoreNames.contains("materials")) d.createObjectStore("materials", { keyPath: "key" });
      if (!d.objectStoreNames.contains("settings")) d.createObjectStore("settings", { keyPath: "key" });
    };
    req.onsuccess = () => { db = req.result; resolve(db); };
    req.onerror = () => reject(req.error);
  });
}

function tx(store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const os = t.objectStore(store);
    const out = fn(os);
    t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : undefined);
    t.onerror = () => reject(t.error);
  });
}

const dbGetAll = (store) => tx(store, "readonly", (os) => os.getAll());
const dbGet = (store, key) => tx(store, "readonly", (os) => os.get(key));
const dbPut = (store, val) => tx(store, "readwrite", (os) => os.put(val));
const dbDelete = (store, key) => tx(store, "readwrite", (os) => os.delete(key));
const dbClear = (store) => tx(store, "readwrite", (os) => os.clear());

const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 8));

// ---------- toast ----------
let toastTimer;
function toast(msg, isErr) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast show" + (isErr ? " err" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}

// ---------- 视图切换 ----------
function switchView(name) {
  $$(".nav-item").forEach((b) => b.classList.toggle("on", b.dataset.view === name));
  $$(".view").forEach((v) => v.classList.toggle("on", v.id === "view" + name[0].toUpperCase() + name.slice(1)));
  const hash = "#" + name;
  if (location.hash !== hash) history.replaceState(null, "", hash);
  if (name === "profile") renderProfile();
  if (name === "track") loadTrack();
  if (name === "settings") loadSettings();
  if (name === "analyze") window.scrollTo(0, 0);
}
window.switchView = switchView;
$$(".nav-item").forEach((b) => b.addEventListener("click", () => switchView(b.dataset.view)));

// ---------- LLM 设置 ----------
async function getLlmSettings() {
  const row = await dbGet("settings", "llm");
  return row || null;
}

async function llmFetch(path, body) {
  // 每次调用都从 IndexedDB 读最新设置——保存即可生效，无中间状态可失同步
  const s = (await getLlmSettings()) || {};
  const res = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-llm-key": s.apiKey || "",
      "x-llm-base-url": s.baseUrl || "",
      "x-llm-model": s.model || "",
      "x-llm-json-schema": s.supportsJsonSchema ? "1" : "0",
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "请求失败");
  return data;
}

async function refreshNavStatus() {
  const s = await getLlmSettings();
  const el = $("#navStatus");
  const configured = s && s.apiKey && s.baseUrl && s.model;
  if (configured) {
    el.className = "nav-status ok";
    el.textContent = "模型已就绪 · " + (s.model || "");
  } else {
    el.className = "nav-status";
    el.innerHTML = '模型未配置，<a href="#" onclick="switchView(\'settings\');return false">去设置</a>';
  }
  // 落地页 CTA：已配置模型时隐藏「先去配置模型」
  const setupBtn = $("#landingSetupBtn");
  if (setupBtn) setupBtn.classList.toggle("hidden", Boolean(configured));
}

// ---------- 我的档案：简历库（HTML + PDF） ----------
async function loadResumes() {
  resumes = (await dbGetAll("resumes")).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

// pdf.js 懒加载（首次用 PDF 时才拉）
let pdfjsReady = null;
function loadPdfJs() {
  if (pdfjsReady) return pdfjsReady;
  pdfjsReady = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/legacy/build/pdf.min.js";
    s.onload = () => {
      try { window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/legacy/build/pdf.worker.min.js"; resolve(window.pdfjsLib); }
      catch (e) { reject(e); }
    };
    s.onerror = () => reject(new Error("PDF 组件加载失败——当前离线或 CDN 不可用，可改传 HTML 简历"));
    document.head.appendChild(s);
  });
  return pdfjsReady;
}

async function extractPdfText(file) {
  const pdfjs = await loadPdfJs();
  const buf = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: buf }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    // 坐标分行重建：y 相近的归一行、行内按 x 排序——双栏 PDF 左右两栏各自的行序保持正确
    const lines = [];
    for (const it of content.items) {
      if (!("str" in it) || typeof it.str !== "string") continue;
      const x = it.transform?.[4] ?? 0;
      const y = Math.round(it.transform?.[5] ?? 0);
      let line = lines.find((l) => Math.abs(l.y - y) <= 3);
      if (!line) { line = { y, parts: [] }; lines.push(line); }
      line.parts.push({ x, str: it.str, hasEOL: it.hasEOL });
    }
    lines.sort((a, b) => b.y - a.y); // y 轴向下递减，从上到下
    // 用相邻行距的众数估计行高，间隔 > 1.8 倍行高视为段落跳变
    const gaps = [];
    for (let i = 1; i < lines.length; i++) {
      const g = lines[i - 1].y - lines[i].y;
      if (g > 0) gaps.push(g);
    }
    const lineGap = gaps.length ? gaps.slice().sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : 14;
    let prevY = null;
    const out = [];
    for (const l of lines) {
      l.parts.sort((a, b) => a.x - b.x);
      const text = l.parts.map((p) => p.str).join(" ").replace(/\s+/g, " ").trim();
      if (!text) continue;
      if (prevY !== null && prevY - l.y > lineGap * 1.8) out.push("");
      out.push(text);
      prevY = l.y;
    }
    pages.push(out.join("\n"));
  }
  return pages.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

async function addResumeFiles(files) {
  let added = 0;
  for (const file of files) {
    if (/\.pdf$/i.test(file.name)) {
      // PDF：提取文本 → LLM 解析成结构化简历 → 可编辑预览确认
      try {
        toast(`正在解析 ${file.name}…`);
        const resumeText = await extractPdfText(file);
        if (!resumeText.trim()) { toast(`${file.name} 没有提取到文本（可能是扫描件），请改用 HTML`, true); continue; }
        const data = await llmFetch("/api/parse-resume", { resumeText });
        openStructuredEditor({
          name: file.name.replace(/\.pdf$/i, ""),
          data: data.resume,
          rawText: resumeText,
        });
        added++;
      } catch (err) { toast(err.message, true); }
    } else if (/\.html?$/i.test(file.name)) {
      const html = await file.text();
      if (!html.trim()) continue;
      await dbPut("resumes", {
        id: uuid(), name: file.name.replace(/\.html?$/i, ""), html, kind: "html",
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
      added++;
    }
  }
  await loadResumes();
  if (added && resumes.some((r) => r.kind !== "structured")) toast(`已上传 ${added} 份简历`);
  renderProfile();
  await refreshAnalyzeEntry();
}

function fmtSize(html) {
  const kb = new Blob([html || ""]).size / 1024;
  return kb > 1024 ? (kb / 1024).toFixed(1) + " MB" : Math.round(kb) + " KB";
}

function fmtDate(iso) { return (iso || "").slice(0, 10); }

async function renderProfile() {
  await loadResumes();
  renderLibrary();
  await renderMaterials();
}

async function renderLibrary() {
  const grid = $("#resumeGrid");
  grid.innerHTML = "";
  $("#libraryEmpty").style.display = resumes.length === 0 ? "" : "none";
  resumes.forEach((r) => {
    const div = document.createElement("div");
    const isStruct = r.kind === "structured";
    div.className = "resume-card";
    div.innerHTML = `
      <span style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
        <span class="fmt-badge">${isStruct ? "PDF版" : "HTML版"}</span>
        ${r.derivedFrom ? '<span class="resume-tag">派生</span>' : ""}
      </span>
      <span class="resume-name" title="${esc(r.name)}">${esc(r.name)}</span>
      <span class="resume-meta">${isStruct ? countResume(r.data) : fmtSize(r.html)} · ${fmtDate(r.updatedAt)}</span>
      <div class="resume-actions">
        <button class="btn ghost" data-act="preview" data-id="${r.id}">预览</button>
        <button class="btn ghost" data-act="rename" data-id="${r.id}">重命名</button>
        <button class="btn ghost" data-act="download" data-id="${r.id}">下载</button>
        ${isStruct ? '<button class="btn ghost" data-act="editstruct" data-id="' + r.id + '">编辑</button>' : ""}
        <button class="btn danger" data-act="delete" data-id="${r.id}">删除</button>
      </div>`;
    grid.appendChild(div);
  });
}

function countResume(data) {
  const n = (data?.experiences?.length ?? 0) + (data?.projects?.length ?? 0);
  return `${n} 段经历`;
}

$("#resumeGrid").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const r = resumes.find((x) => x.id === btn.dataset.id);
  if (!r) return;
  const act = btn.dataset.act;
  if (act === "preview") {
    if (r.kind === "structured") { openStructuredEditor({ name: r.name, data: r.data, existingId: r.id, readOnly: true }); return; }
    const blob = new Blob([r.html], { type: "text/html" });
    window.open(URL.createObjectURL(blob), "_blank");
  } else if (act === "editstruct") {
    openStructuredEditor({ name: r.name, data: r.data, existingId: r.id });
  } else if (act === "rename") {
    const name = prompt("新名称：", r.name);
    if (name && name.trim() && name.trim() !== r.name) {
      await dbPut("resumes", { ...r, name: name.trim(), updatedAt: new Date().toISOString() });
      renderProfile();
      await refreshAnalyzeEntry();
    }
  } else if (act === "download") {
    if (r.kind === "structured") { downloadStructuredPdf(r); return; }
    downloadText(r.html, r.name + ".html");
  } else if (act === "delete") {
    if (!confirm(`删除「${r.name}」？此操作不可恢复。`)) return;
    await dbDelete("resumes", r.id);
    renderProfile();
    await refreshAnalyzeEntry();
  }
});

function downloadText(text, filename) {
  const blob = new Blob([text], { type: "text/html;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

// 上传入口：dropzone + 落地页按钮 + 拖放
$("#dropzone").addEventListener("click", () => $("#libraryFileInput").click());
$("#libraryFileInput").addEventListener("change", async (e) => { await addResumeFiles(e.target.files); e.target.value = ""; });
["dragover", "dragenter"].forEach((ev) => $("#dropzone").addEventListener(ev, (e) => { e.preventDefault(); $("#dropzone").classList.add("drag"); }));
["dragleave", "drop"].forEach((ev) => $("#dropzone").addEventListener(ev, (e) => { e.preventDefault(); $("#dropzone").classList.remove("drag"); }));
$("#dropzone").addEventListener("drop", async (e) => { await addResumeFiles(e.dataTransfer.files); });

// 落地页 ⇄ 向导 转场
let wizardActive = false;
function enterWizard() {
  if (wizardActive) return;
  wizardActive = true;
  const landing = $("#landing");
  landing.classList.add("leaving");
  setTimeout(() => {
    landing.style.display = "none";
    const wiz = $("#wizardBox");
    wiz.classList.remove("hidden");
    wiz.classList.add("entering");
    window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
    setTimeout(() => wiz.classList.remove("entering"), 400);
  }, 300);
}
function backToLanding() {
  wizardActive = false;
  $("#wizardBox").classList.add("hidden");
  const landing = $("#landing");
  landing.style.display = "";
  landing.classList.remove("leaving");
  window.scrollTo(0, 0);
}
$("#landingCta").addEventListener("click", enterWizard);
$("#backToLandingBtn").addEventListener("click", backToLanding);
$("#landingSetupBtn").addEventListener("click", () => switchView("settings"));

// ---------- 素材卡系统 ----------
let matCards = [];

const CARD_META = {
  exp: { label: "经历", titlePh: "例：美团 · 算法实习生 / 班长 / 校篮球社社长" },
  trait: { label: "特质", titlePh: "例：不喜欢安稳，偏好 0→1" },
  result: { label: "成果", titlePh: "例：付费节点到达率 3.26%" },
  note: { label: "随手记", titlePh: "例：雅思 7.0；会 Final Cut" },
};

const STAR_FIELDS = [
  { key: "situation", label: "S 情境", ph: "当时的背景是什么？例：运营内容生产效率低，热点靠人工判断", type: "textarea" },
  { key: "task", label: "T 任务", ph: "你要解决的问题是什么？一句话", type: "textarea" },
  { key: "action", label: "A 行动", ph: "你具体做了什么？动词开头，两三句", type: "textarea" },
  { key: "result", label: "R 结果", ph: "结果如何？有数字给数字和口径，没数字给定性变化", type: "textarea" },
];

const TRAIT_FIELDS = [
  { key: "evidence", label: "证据", ph: "一件能证明它的事，别写形容词。例：主动从实习拧去创业公司", type: "textarea" },
  { key: "fit", label: "适配", ph: "什么环境适合你？例：早期团队、探索型岗位，而非成熟维护型", type: "textarea" },
];

const RESULT_FIELDS = [
  { key: "caliber", label: "口径", ph: "和谁比、怎么算的、benchmark 是什么", type: "textarea" },
];

async function loadMatCards() {
  const row = await dbGet("materials", "cards");
  matCards = row?.cards || [];
}

async function saveMatCards() {
  // _open 是纯 UI 态，不入库
  const cards = matCards.map(({ _open, ...rest }) => rest);
  await dbPut("materials", { key: "cards", cards });
}

// 卡片 → 素材文本（喂给现有 prompt，格式与原素材库兼容）
function serializeCards(cards) {
  const out = [];
  for (const c of cards) {
    if (c.type === "exp") {
      const lines = [`【经历】${c.title}`];
      if (c.situation) lines.push(`- 情境：${c.situation}`);
      if (c.task) lines.push(`- 任务：${c.task}`);
      if (c.action) lines.push(`- 行动：${c.action}`);
      if (c.result) lines.push(`- 结果：${c.result}`);
      if (c.whyNotOnResume) lines.push(`- 未上简历原因：${c.whyNotOnResume}`);
      out.push(lines.join("\n"));
    } else if (c.type === "trait") {
      out.push(`【特质】${c.title}${c.evidence ? `——证据：${c.evidence}` : ""}${c.fit ? `；适配环境：${c.fit}` : ""}`);
    } else if (c.type === "result") {
      out.push(`【成果】${c.title}${c.caliber ? `（口径：${c.caliber}）` : ""}${c.result ? `——${c.result}` : ""}`);
    } else if (c.type === "note" && c.text) {
      out.push(`【记录】${c.text}`);
    }
  }
  return out.join("\n\n");
}

const MAT_READONLY_FIELDS = {
  exp: [["情境", "situation"], ["任务", "task"], ["行动", "action"], ["结果", "result"], ["为何没上简历", "whyNotOnResume"]],
  trait: [["证据", "evidence"], ["适配", "fit"]],
  result: [["结果", "result"], ["口径", "caliber"]],
  note: [["内容", "text"]],
};

async function renderMaterials() {
  await loadMatCards();
  const box = $("#matCards");
  box.innerHTML = "";
  $("#matEmpty").style.display = matCards.length === 0 ? "" : "none";
  matCards.forEach((c, i) => {
    const meta = CARD_META[c.type] || CARD_META.note;
    const div = document.createElement("div");
    div.className = "mat-card" + (c._open ? " open" : "");
    const roFields = MAT_READONLY_FIELDS[c.type] || [];
    const readonly = roFields
      .filter(([k, key]) => (c[key] || "").trim())
      .slice(0, 3)
      .map(([k, key]) => `<div class="rl"><span class="k">${k}</span><span class="v">${esc(c[key])}</span></div>`)
      .join("");
    div.innerHTML = `
      <div class="mat-card-head" data-mat-toggle="${i}">
        <span class="mat-type ${c.type}">${meta.label}</span>
        <span class="mat-title">${esc(c.title || "（未命名）")}</span>
        <span class="chev">▶</span>
      </div>
      <div class="mat-readonly">${readonly || '<div class="rl"><span class="k"></span><span class="v" style="color:#a2a5aa">（还没写内容，点开编辑）</span></div>'}</div>
      <div class="mat-card-body"></div>`;
    box.appendChild(div);
    renderMatCardBody(div, c, i);
  });
}

function renderMatCardBody(div, c, i) {
  const body = div.querySelector(".mat-card-body");
  const meta = CARD_META[c.type] || CARD_META.note;
  const fields = c.type === "exp" ? STAR_FIELDS : c.type === "trait" ? TRAIT_FIELDS : c.type === "result" ? RESULT_FIELDS : [];
  let html = `<div class="field" style="margin-top:0"><label class="field-label">标题</label>
    <input type="text" data-mat-field="title" value="${esc(c.title || "")}" placeholder="${esc(meta.titlePh)}"></div>`;
  for (const f of fields) {
    html += `<div class="star-field"><label class="field-label">${esc(f.label)}</label>
      <textarea data-mat-field="${f.key}" style="min-height:60px" placeholder="${esc(f.ph)}">${esc(c[f.key] || "")}</textarea></div>`;
  }
  if (c.type === "exp") {
    html += `<div class="star-field"><label class="field-label">为什么不在简历上<span style="font-weight:400;color:#8a8f98">（可选）</span></label>
      <textarea data-mat-field="whyNotOnResume" style="min-height:48px" placeholder="例：和现在的产品方向不符，被裁掉了">${esc(c.whyNotOnResume || "")}</textarea></div>`;
  }
  if (c.type === "note") {
    html += `<div class="star-field"><label class="field-label">内容</label>
      <textarea data-mat-field="text" style="min-height:80px" placeholder="想到什么记什么…">${esc(c.text || "")}</textarea></div>`;
  }
  html += `<div class="step-foot" style="margin-top:10px"><span></span><span style="display:inline-flex;gap:8px"><button class="btn sm" data-mat-save="${i}">保存</button><button class="btn danger sm" data-mat-del="${i}">删除这张卡</button></span></div>`;
  body.innerHTML = html;
}

// 折叠/展开 + 字段编辑（防抖保存到 IndexedDB）
$("#matCards").addEventListener("click", (e) => {
  const toggle = e.target.closest("[data-mat-toggle]");
  if (toggle) {
    const i = Number(toggle.dataset.matToggle);
    matCards[i]._open = !matCards[i]._open;
    toggle.closest(".mat-card").classList.toggle("open");
    return;
  }
  const del = e.target.closest("[data-mat-del]");
  if (del) {
    const i = Number(del.dataset.matDel);
    if (!confirm(`删除「${matCards[i].title || "未命名卡"}」？`)) return;
    matCards.splice(i, 1);
    saveMatCards().then(renderMaterials);
  }
});

$("#matCards").addEventListener("input", (e) => {
  const field = e.target.closest("[data-mat-field]");
  if (!field) return;
  const card = field.closest(".mat-card");
  const i = Number(card.querySelector("[data-mat-toggle]").dataset.matToggle);
  matCards[i][field.dataset.matField] = field.value;
  const btn = card.querySelector("[data-mat-save]");
  if (btn) btn.classList.add("dirty");
  // 更新折叠态预览行
  const c = matCards[i];
  const preview = c.type === "note" ? (c.text || "") : (c.action || c.evidence || c.result || c.situation || "");
  const pEl = card.querySelector(".mat-preview");
  if (pEl) pEl.textContent = preview.slice(0, 60) + (preview.length > 60 ? "…" : "");
  const tEl = card.querySelector(".mat-title");
  if (tEl && field.dataset.matField === "title") tEl.textContent = c.title || "（未命名）";
});

$("#matCards").addEventListener("click", async (e) => {
  const save = e.target.closest("[data-mat-save]");
  if (!save) return;
  const card = save.closest(".mat-card");
  const i = Number(card.querySelector("[data-mat-toggle]").dataset.matToggle);
  save.disabled = true;
  save.textContent = "保存中…";
  // 先收起再入库：saveMatCards 会把 _open 一起写进 IndexedDB，renderMaterials 读回后以此为准
  matCards[i]._open = false;
  await saveMatCards();
  renderMaterials();
});

// 添加卡片
$$("[data-add-card]").forEach((b) => b.addEventListener("click", async () => {
  const type = b.dataset.addCard;
  matCards.unshift({ id: uuid(), type, title: "", _open: true, createdAt: new Date().toISOString() });
  await saveMatCards();
  renderMaterials();
  const first = $("#matCards .mat-card input[data-mat-field=title]");
  if (first) first.focus();
}));

// ---------- 素材种子（从简历提取） ----------
$("#seedBtn").addEventListener("click", () => {
  $("#seedBox").classList.remove("hidden");
  $("#seedCandidates").innerHTML = "";
});
$("#seedCancel").addEventListener("click", () => $("#seedBox").classList.add("hidden"));

$("#seedGo").addEventListener("click", async () => {
  const resumeText = $("#seedText").value.trim();
  if (!resumeText) { showError("#seedError", "先粘贴简历或自述文本"); return; }
  $("#seedError").classList.add("hidden");
  const btn = $("#seedGo");
  btn.disabled = true;
  btn.textContent = "提取中…";
  try {
    const data = await llmFetch("/api/seed-materials", { resumeText });
    renderSeedCandidates(data.cards || []);
  } catch (err) {
    showError("#seedError", err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "提取";
  }
});

function renderSeedCandidates(cards) {
  const box = $("#seedCandidates");
  if (!cards.length) { box.innerHTML = '<div class="vs-why">没有提取到候选素材——试试补充一句提示（比如「我当过班长」）再提取</div>'; return; }
  box.innerHTML = '<div class="sec-label" style="margin-top:0">候选素材 · 勾选后点「收录」</div>';
  cards.forEach((c, i) => {
    const meta = CARD_META[c.type] || CARD_META.note;
    const body = c.type === "exp"
      ? [c.situation && `情境：${c.situation}`, c.task && `任务：${c.task}`, c.action && `行动：${c.action}`, c.result && `结果：${c.result}`].filter(Boolean).map((x) => `<div style="font-size:12.5px;color:#5c616b;margin-top:2px">${esc(x)}</div>`).join("")
      : c.type === "trait"
        ? [c.evidence && `证据：${c.evidence}`, c.fit && `适配：${c.fit}`].filter(Boolean).map((x) => `<div style="font-size:12.5px;color:#5c616b;margin-top:2px">${esc(x)}</div>`).join("")
        : `<div style="font-size:12.5px;color:#5c616b;margin-top:2px">${esc(c.caliber || c.result || "")}</div>`;
    box.insertAdjacentHTML("beforeend", `
      <div class="seed-candidate">
        <label style="display:flex;gap:10px;align-items:flex-start;cursor:pointer">
          <input type="checkbox" checked data-seed-idx="${i}" style="margin-top:3px;accent-color:#18191b">
          <span style="min-width:0">
            <span style="display:inline-flex;gap:6px;align-items:center"><span class="mat-type ${c.type}">${meta.label}</span><b style="font-size:13.5px">${esc(c.title)}</b></span>
            ${body}
            <div class="seed-reason" style="margin-top:4px">✓ ${esc(c.reasonForCandidate)}</div>
          </span>
        </label>
      </div>`);
    box.querySelectorAll(".seed-candidate")[i].dataset.card = JSON.stringify(c);
  });
  box.insertAdjacentHTML("beforeend", `<div class="step-foot" style="margin-top:12px"><span></span><button class="btn sm" id="seedAccept">收录勾选的素材</button></div>`);
  $("#seedAccept").addEventListener("click", async () => {
    const accepted = [...box.querySelectorAll("[data-seed-idx]:checked")].map((cb) => JSON.parse(cb.closest(".seed-candidate").dataset.card));
    if (!accepted.length) { toast("没有勾选任何素材"); return; }
    for (const c of accepted) matCards.unshift({ ...c, id: uuid(), createdAt: new Date().toISOString() });
    await saveMatCards();
    $("#seedBox").classList.add("hidden");
    $("#seedText").value = "";
    $("#seedCandidates").innerHTML = "";
    renderMaterials();
    toast(`已收录 ${accepted.length} 张素材卡`);
  });
}

// 隐藏经历池（我的档案页）防抖保存
function bindPoolSave() {
  const el = $("#hiddenPoolText");
  const hint = $("#poolSaved");
  if (el.dataset.bound) return;
  el.dataset.bound = "1";
  let timer;
  el.addEventListener("input", () => {
    hint.style.visibility = "hidden";
    clearTimeout(timer);
    timer = setTimeout(async () => {
      await dbPut("materials", { key: "hiddenPool", text: el.value });
      hint.style.visibility = "visible";
    }, 600);
  });
}

// ---------- 结构化简历编辑器（PDF 解析确认 / 预览 / 编辑） ----------
const SE_SECTIONS = [
  { key: "experiences", label: "经历", itemTitle: "公司", addItem: "添加一段经历" },
  { key: "education", label: "教育", itemTitle: "学校", addItem: "添加一段教育" },
  { key: "projects", label: "项目", itemTitle: "项目名", addItem: "添加一个项目" },
];

function openStructuredEditor({ name, data, existingId, readOnly, rawText }) {
  const overlay = document.createElement("div");
  overlay.style.cssText = "position:fixed;inset:0;background:rgba(24,25,27,.4);z-index:60;display:grid;place-items:center;padding:20px;overflow:auto";
  const dialog = document.createElement("div");
  dialog.className = "card";
  dialog.style.cssText = "max-width:680px;width:100%;max-height:88vh;overflow:auto;padding:24px";
  data.contact = data.contact || {};
  for (const s of SE_SECTIONS) data[s.key] = data[s.key] || [];

  const field = (label, value, key, opts = {}) =>
    `<div class="field"><label class="field-label">${esc(label)}${opts.low ? ' <span style="color:#9a6d0c;font-weight:600">待确认</span>' : ""}</label>
     <input type="text" data-se-field="${key}" value="${esc(value ?? "")}" ${readOnly ? "disabled" : ""}></div>`;

  const secEditor = (arrKey, label, itemTitle, addItemLabel) => {
    const arr = data[arrKey];
    return `<div class="sec-label">${label} <span class="sec-count">${arr.length} 段</span></div>` +
      arr.map((x, i) => `
        <div data-se-sec="${arrKey}" data-se-idx="${i}" style="border:1px solid #f0f1f3;border-radius:8px;padding:12px 14px;margin-bottom:10px;position:relative">
          ${readOnly ? "" : `<button type="button" data-se-del="${arrKey}:${i}" style="position:absolute;top:8px;right:10px;font-size:11px;color:#8a8f98;background:none;border:none;cursor:pointer;padding:2px 4px">删除</button>`}
          ${field(itemTitle, x.org ?? x.name, `${arrKey}.${i}.title`, { low: x.confidence === "low" })}
          ${field(arrKey === "education" ? "专业" : "职位", x.role ?? x.major, `${arrKey}.${i}.role`, { low: x.confidence === "low" })}
          ${field("时间", x.period, `${arrKey}.${i}.period`)}
          ${(x.bullets || []).map((b, j) => `
            <div class="star-field"><label class="field-label">条目 ${j + 1}</label>
            <textarea data-se-field="${arrKey}.${i}.bullets.${j}" style="min-height:52px" ${readOnly ? "disabled" : ""}>${esc(b)}</textarea></div>`).join("")}
          ${readOnly ? "" : `<button type="button" data-se-addbullet="${arrKey}:${i}" class="se-add-btn">+ 添加条目</button>`}
        </div>`).join("") +
      (readOnly ? "" : `<button type="button" data-se-additem="${arrKey}" class="se-add-btn" style="margin-bottom:16px">+ ${addItemLabel}</button>`);
  };

  const renderBody = () => {
    dialog.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px;margin-bottom:6px">
      <b style="font-size:16px">${esc(name)} · 结构化简历</b>
      <span style="font-size:11.5px;color:#8a8f98">${readOnly ? "预览" : "核对解析结果，漏的部分点 + 手动补填"}</span>
    </div>
    ${rawText != null ? `
    <details style="margin-bottom:12px">
      <summary style="font-size:12px;color:#8a8f98;cursor:pointer">PDF 提取的原始文本（解析不对时点开核对）</summary>
      <textarea readonly style="width:100%;min-height:120px;margin-top:6px;font-size:11.5px;color:#5c616b">${esc(rawText)}</textarea>
    </details>` : ""}
    ${field("姓名", data.name, "name")}
    ${field("邮箱", data.contact?.email, "contact.email")}
    ${field("电话", data.contact?.phone, "contact.phone")}
    ${field("个人主页（每行一个）", (data.contact?.links || []).join("\n"), "contact.links")}
    ${field("个人总结", data.summary, "summary")}
    ${secEditor("experiences", "经历", "公司", "添加一段经历")}
    ${secEditor("education", "教育", "学校", "添加一段教育")}
    ${secEditor("projects", "项目", "项目名", "添加一个项目")}
    <div class="step-foot" style="margin-top:14px">
      <button class="btn ghost" id="seCancel">关闭</button>
      ${readOnly ? "" : '<button class="btn" id="seSave">保存到简历库</button>'}
    </div>`;
    dialog.querySelector("#seCancel").addEventListener("click", () => overlay.remove());
    const saveBtn = dialog.querySelector("#seSave");
    if (saveBtn) saveBtn.addEventListener("click", save);
  };

  // 编辑中的输入实时写回 data（重渲染前同步，避免丢失）
  const syncInputs = () => {
    dialog.querySelectorAll("[data-se-field]").forEach((el) => {
      const path = el.dataset.seField.split(".");
      let obj = data;
      for (let k = 0; k < path.length - 1; k++) {
        const seg = path[k];
        obj = /^\d+$/.test(seg) ? obj[Number(seg)] : (obj[seg] = obj[seg] || {});
      }
      const last = path[path.length - 1];
      if (last === "links") obj[last] = el.value.split("\n").map((s) => s.trim()).filter(Boolean);
      else if (/^\d+$/.test(last)) obj[Number(last)] = el.value;
      else obj[last] = el.value;
    });
  };

  const rerender = () => { syncInputs(); renderBody(); };

  const onAddItem = (arrKey) => {
    syncInputs();
    const arr = data[arrKey];
    const blank = arrKey === "education"
      ? { school: "", major: "", period: "" }
      : { org: "", role: "", period: "", bullets: [""] };
    if (arrKey === "education") delete blank.org;
    arr.push(blank);
    renderBody();
    // 滚到新卡片并聚焦第一个输入框
    const cards = dialog.querySelectorAll(`[data-se-sec="${arrKey}"]`);
    const last = cards[cards.length - 1];
    if (last) { last.scrollIntoView({ block: "nearest" }); last.querySelector("input")?.focus(); }
  };

  const onAddBullet = (arrKey, i) => {
    syncInputs();
    const item = data[arrKey][i];
    item.bullets = item.bullets || [];
    item.bullets.push("");
    renderBody();
    const card = dialog.querySelector(`[data-se-sec="${arrKey}"][data-se-idx="${i}"]`);
    const tas = card?.querySelectorAll("textarea");
    if (tas?.length) { tas[tas.length - 1].focus(); }
  };

  const onDelItem = (arrKey, i) => {
    syncInputs();
    data[arrKey].splice(i, 1);
    renderBody();
  };

  dialog.addEventListener("click", (e) => {
    const t = e.target.closest("[data-se-additem],[data-se-addbullet],[data-se-del]");
    if (!t) return;
    if (t.dataset.seAdditem) onAddItem(t.dataset.seAdditem);
    else if (t.dataset.seAddbullet) { const [k, i] = t.dataset.seAddbullet.split(":"); onAddBullet(k, Number(i)); }
    else if (t.dataset.seDel) { const [k, i] = t.dataset.seDel.split(":"); onDelItem(k, Number(i)); }
  });

  const save = async () => {
    syncInputs();
    // 过滤全空条目和空 bullet
    for (const s of SE_SECTIONS) {
      data[s.key] = (data[s.key] || []).filter((x) => (x.org ?? x.school ?? x.name ?? "").trim() || (x.bullets || []).some((b) => b.trim()));
      data[s.key].forEach((x) => { if (Array.isArray(x.bullets)) x.bullets = x.bullets.filter((b) => b.trim()); });
    }
    const now = new Date().toISOString();
    if (existingId) {
      const r = resumes.find((x) => x.id === existingId);
      await dbPut("resumes", { ...r, data, updatedAt: now });
    } else {
      await dbPut("resumes", { id: uuid(), name, kind: "structured", data, createdAt: now, updatedAt: now });
    }
    overlay.remove();
    await loadResumes();
    renderProfile();
    await refreshAnalyzeEntry();
    toast(`已保存「${name}」`);
  };

  renderBody();
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
}

// ---------- 结构化简历 → PDF（pdf-lib 懒加载） ----------
let pdfLibReady = null;
function loadPdfLib() {
  if (pdfLibReady) return pdfLibReady;
  pdfLibReady = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js";
    s.onload = () => resolve(window.PDFLib);
    s.onerror = () => reject(new Error("PDF 导出组件加载失败——当前离线或 CDN 不可用，可先下载 HTML 版"));
    document.head.appendChild(s);
  });
  return pdfLibReady;
}

async function downloadStructuredPdf(resume) {
  try {
    const lib = await loadPdfLib();
    const { PDFDocument, StandardFonts, rgb } = lib;
    const doc = await PDFDocument.create();
    let page = doc.addPage([595.28, 841.89]); // A4
    const font = await doc.embedFont(StandardFonts.Helvetica);
    // 中文输出：pdf-lib 标准字体无 CJK 字形，直接写会抛错——降级为 HTML 下载
    const hasCJK = /[一-鿿]/.test(structuredToText(resume.data));
    if (hasCJK) {
      toast("当前 PDF 导出暂不支持中文（需嵌入中文字体，体积较大）——已下载 HTML 版，浏览器打印即可存为 PDF", true);
      downloadText(structuredPreviewHtml(resume.data, resume.name), resume.name + ".html");
      return;
    }
    const { width, height } = page.getSize();
    let y = height - 60;
    const line = (text, size = 11, gray = 0.15, bold = false) => {
      if (y < 60) { page = doc.addPage([595.28, 841.89]); y = height - 60; }
      page.drawText(text, { x: 50, y, size, font, color: rgb(gray, gray, gray) });
      y -= size + 7;
    };
    const d = resume.data;
    line(d.name || resume.name, 20, 0.09);
    const c = [d.contact?.email, d.contact?.phone, ...(d.contact?.links || [])].filter(Boolean);
    if (c.length) line(c.join(" · "), 10, 0.45);
    if (d.summary) { y -= 6; line(d.summary, 10, 0.3); }
    const sec = (title, arr) => {
      if (!arr?.length) return;
      y -= 8;
      line(title, 12, 0.09);
      y -= 2;
      arr.forEach((x) => {
        line(`${x.org || x.name || ""}${x.role ? " — " + x.role : ""}${x.period ? " (" + x.period + ")" : ""}`, 11, 0.15);
        (x.bullets || []).forEach((b) => line("• " + b, 10, 0.3));
        if (x.tags?.length) line("Tags: " + x.tags.join(" / "), 9, 0.5);
        y -= 4;
      });
    };
    sec("Experience", d.experiences);
    sec("Projects", d.projects);
    if (d.education?.length) {
      y -= 8; line("Education", 12, 0.09); y -= 2;
      d.education.forEach((e) => line(`${e.school}${e.degree ? " — " + e.degree : ""}${e.major ? ", " + e.major : ""}${e.period ? " (" + e.period + ")" : ""}`, 10, 0.3));
    }
    if (d.skills) {
      y -= 8; line("Skills", 12, 0.09); y -= 2;
      const txt = Array.isArray(d.skills) ? d.skills.join(" · ") : (d.skills.groups || []).map((g) => g.label + ": " + g.items.join(" / ")).join("  ");
      line(txt, 10, 0.3);
    }
    const bytes = await doc.save();
    const blob = new Blob([bytes], { type: "application/pdf" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = resume.name + ".pdf";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  } catch (err) {
    toast(err.message, true);
  }
}

// ---------- 向导入口态 ----------
async function refreshAnalyzeEntry() {
  if (resumes.length > 0) {
    renderResumePickGrid();
    if (!selectedResumeId || !resumes.find((r) => r.id === selectedResumeId)) {
      selectedResumeId = resumes[0].id;
    }
    updateBaseInfo();
  }
}

function renderResumePickGrid() {
  const grid = $("#resumePickGrid");
  grid.innerHTML = "";
  resumes.forEach((r) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "resume-pick" + (r.id === selectedResumeId ? " sel" : "");
    b.innerHTML = `${esc(r.name)}<span class="rp-meta">${fmtDate(r.updatedAt)}${r.derivedFrom ? " · 派生" : ""}</span>`;
    b.addEventListener("click", () => { selectedResumeId = r.id; renderResumePickGrid(); updateBaseInfo(); });
    grid.appendChild(b);
  });
  const upload = document.createElement("button");
  upload.type = "button";
  upload.className = "resume-pick";
  upload.textContent = "＋ 上传新简历";
  upload.addEventListener("click", () => { switchView("profile"); $("#libraryFileInput").click(); });
  grid.appendChild(upload);
}

function updateBaseInfo() {
  const r = resumes.find((x) => x.id === selectedResumeId);
  $("#baseInfo").textContent = "base：" + (r ? r.name : "未选择");
}

const STEP_NAMES = ["贴 JD 选简历", "岗位实际在做什么", "岗位匹配度判断", "确认修改", "应用与验证"];

function renderRail(cur) {
  const rail = $("#railSteps");
  rail.innerHTML = "";
  STEP_NAMES.forEach((name, i) => {
    const n = i + 1;
    const div = document.createElement("div");
    const step4Ready = n === 4 && Array.isArray(currentAnalysis?.editPlan);
    div.className = "rail-step " + (n < cur || step4Ready ? "done" : n === cur ? "cur" : "");
    div.innerHTML = `<span class="n">${n < cur || step4Ready ? "✓" : n}</span><span>${name}</span>`;
    if (n < cur || step4Ready) {
      div.title = "回到这一步";
      div.addEventListener("click", () => gotoStep(n));
    }
    rail.appendChild(div);
  });
}

function gotoStep(n) {
  $$(".step-panel").forEach((p) => p.classList.remove("on"));
  $("#step" + n).classList.add("on");
  renderRail(n);
  window.scrollTo({ top: 0, behavior: "smooth" });
}
$$("[data-goto]").forEach((b) => b.addEventListener("click", () => gotoStep(Number(b.dataset.goto))));

// ---------- 分析 ----------
async function currentResume() {
  if (!selectedResumeId) return null;
  return dbGet("resumes", selectedResumeId);
}

// 结构化简历 → 纯文本（替代 HTML 发给分析端点）
function structuredToText(data) {
  const lines = [];
  if (data.name) lines.push(data.name);
  const c = [data.contact?.email, data.contact?.phone, ...(data.contact?.links || [])].filter(Boolean);
  if (c.length) lines.push(c.join(" · "));
  if (data.summary) lines.push(data.summary);
  (data.education || []).forEach((e) => lines.push(`教育：${e.school}${e.degree ? " · " + e.degree : ""}${e.major ? " · " + e.major : ""}${e.period ? "（" + e.period + "）" : ""}`));
  const sec = (label, arr) => (arr || []).forEach((x) => {
    lines.push(`${label}：${x.org || x.name || ""}${x.role ? " · " + x.role : ""}${x.period ? "（" + x.period + "）" : ""}`);
    (x.bullets || []).forEach((b) => lines.push("- " + b));
    if (x.tags?.length) lines.push("标签：" + x.tags.join(" / "));
  });
  sec("经历", data.experiences);
  sec("项目", data.projects);
  if (data.skills) {
    if (Array.isArray(data.skills)) lines.push("技能：" + data.skills.join(" / "));
    else if (data.skills.groups) data.skills.groups.forEach((g) => lines.push(`技能·${g.label}：${g.items.join(" / ")}`));
  }
  if (data.honors?.length) lines.push("荣誉：" + data.honors.join("；"));
  return lines.join("\n");
}

async function currentMaterials() {
  const cardsRow = await dbGet("materials", "cards");
  const h = await dbGet("materials", "hiddenPool");
  const cards = cardsRow?.cards || [];
  return { materials: serializeCards(cards), hiddenPool: h?.text || "" };
}

$("#analyzeBtn").addEventListener("click", async () => {
  const jdText = $("#jdText").value.trim();
  if (!jdText) { showError("#analyzeError", "请先粘贴 JD"); return; }
  const resume = await currentResume();
  if (!resume) { showError("#analyzeError", "请先选择 base 简历"); return; }
  const { materials, hiddenPool } = await currentMaterials();
  $("#analyzeError").classList.add("hidden");
  $("#analyzeBtn").disabled = true;
  $("#analyzeLoading").classList.remove("hidden");
  try {
    const resumeText = resume.kind === "structured" ? structuredToText(resume.data) : resume.html;
    const data = await llmFetch("/api/analyze", { jdText, resumeHtml: resumeText, materials, hiddenPool });
    currentAnalysis = data;
    currentAnalysis._resumeId = resume.id;
    currentAnalysis._resumeKind = resume.kind;
    renderStep2(data);
    renderStep3(data);
    gotoStep(2);
  } catch (err) {
    showError("#analyzeError", err.message);
  } finally {
    $("#analyzeBtn").disabled = false;
    $("#analyzeLoading").classList.add("hidden");
  }
});

function showError(sel, msg) { const el = $(sel); el.textContent = msg; el.classList.remove("hidden"); }

// ---------- 阶段 2：按需生成修改方案 ----------
async function requestEditPlan() {
  if (!currentAnalysis) return;
  const btn = $("#genEditPlanBtn");
  btn.disabled = true;
  btn.textContent = "生成中…";
  try {
    const resume = await currentResume();
    const { materials, hiddenPool } = await currentMaterials();
    const isStruct = resume.kind === "structured";
    const data = await llmFetch(isStruct ? "/api/editplan-structured" : "/api/editplan", {
      jdText: $("#jdText").value.trim(),
      ...(isStruct ? { resume: resume.data } : { resumeHtml: resume.html }),
      materials, hiddenPool,
      screening: { ...currentAnalysis.screening, jobFamily: currentAnalysis.jdInsight?.jobClassification?.family },
    });
    currentAnalysis.editPlan = data.editPlan;
    currentAnalysis.editPlanStrategy = data.strategy;
    currentAnalysis._resumeKind = isStruct ? "structured" : "html";
    btn.disabled = false;
    btn.textContent = "重新生成修改方案";
    renderStep4(currentAnalysis);
    gotoStep(4);
  } catch (err) {
    showError("#applyError", err.message);
    btn.disabled = false;
    btn.textContent = "仍要生成修改方案";
  }
}

// ---------- 步骤 2：五层解构 ----------
const LAYER_TEXT = { maintenance: "维护", construction: "建设", exploratory: "探索" };

function renderStep2(d) {
  setRecap("#recap2", d.position.company + " · " + d.position.role);
  const ins = d.jdInsight;
  const tc = ins.teamContext;
  const layerBadge = (l) => `<span class="layer-badge ${l}">${LAYER_TEXT[l] || l}</span>`;
  const LAYER_GROUP = [
    { key: "construction", name: "建设性", desc: "团队当前推进的项目，入职后的主要工作" },
    { key: "exploratory", name: "探索性", desc: "尚在预研的方向，存在调整可能" },
    { key: "maintenance", name: "维护性", desc: "保障现有系统稳定运行，含故障处理与值班" },
  ];
  const CLS_TEXT = { family: "职位族", subFamily: "细分", seniority: "级别", nature: "工作性质" };

  const mix = ins.interactionMix;
  const mixRows = mix && typeof mix === "object" && Array.isArray(mix.primary)
    ? `
        <div class="mix-nature">${esc(mix.nature || "")}</div>
        ${(mix.primary || []).map((p) => `
        <div class="mix-line"><span class="freq">高频</span><span><span class="who">${esc(p.who)}</span><span class="what"> — ${esc(p.what)}</span></span></div>`).join("")}
        ${(mix.occasional || []).map((p) => `
        <div class="mix-line occ"><span class="freq">偶尔</span><span><span class="who">${esc(p.who)}</span><span class="what"> — ${esc(p.what)}</span></span></div>`).join("")}`
    : mix && typeof mix === "object"
      ? `<div class="intel-box">${esc(mix.nature || mix.summary || "")}</div>${(mix.primary || []).map((p) => `<div class="intel-box">${esc(p.who)}：${esc(p.what)}</div>`).join("")}`
      : `<div class="intel-box">${esc(String(mix ?? ""))}</div>`;

  $("#jdInsightBody").innerHTML = `
    <div class="cards">
      <div class="card">
        <div class="card-head">
          <span class="t">岗位定性</span>
          <span class="h">职位类别、组织位置与协作对象</span>
          ${ins.mode === "generative" ? '<span class="gen-badge">生成模式 · 内容为假设</span>' : ""}
        </div>
        ${ins.jobClassification ? `
        <div class="cls-chips">
          <span class="cls-chip main"><span class="k">${CLS_TEXT.family}</span><span class="v">${esc(ins.jobClassification.family)}</span></span>
          <span class="cls-chip"><span class="k">${CLS_TEXT.subFamily}</span><span class="v">${esc(ins.jobClassification.subFamily)}</span></span>
          <span class="cls-chip"><span class="k">${CLS_TEXT.seniority}</span><span class="v">${esc(ins.jobClassification.seniority)}</span></span>
        </div>
        ${ins.jobClassification.nature ? `<div class="team-meta" style="margin-bottom:10px">${esc(ins.jobClassification.nature)}</div>` : ""}` : ""}
        <div class="oneliner">${esc(tc.oneLiner)}</div>
        <div class="team-meta">${esc(tc.orgPosition)} · ${esc(tc.whoFor)}</div>
        <div class="misread"><b>误读风险：</b>${esc(tc.misreadRisk)}</div>
        <div class="mix-sub">交互画像 · 协作对象与强度</div>
        ${mixRows}
      </div>

      <div class="card">
        <div class="card-head">
          <span class="t">职责翻译与典型工作日</span>
          <span class="h">JD 原文怎么写的、实际意味着什么</span>
        </div>
        ${(ins.jargon || []).length ? `
        <div class="mix-sub" style="margin-top:0">行话速成</div>
        <div class="jargon-panel">
          ${ins.jargon.map((j) => `
          <div class="jargon-item">
            <span class="jargon-term">${esc(j.term)}</span>
            <span class="jargon-plain">${esc(j.plain)}</span>
            <span class="jargon-injob">在这个岗位：${esc(j.inThisJob)}</span>
          </div>`).join("")}
        </div>` : ""}
        <div class="mix-sub">任务结构 · 按建设 / 探索 / 维护三类分组</div>
        ${LAYER_GROUP.map((g) => {
          const items = ins.duties.filter((r) => r.layer === g.key);
          if (!items.length) return "";
          return `
        <div class="duty-group">
          <div class="duty-group-head"><span class="layer-badge ${g.key}">${g.name}</span><span class="gs">${g.desc}</span></div>
          ${items.map((r) => `
          <div class="duty-item">
            <div class="duty-meta"><span class="time-share">${esc(r.timeShare)}</span></div>
            <div class="duty-text">${esc(r.duty)}</div>
            <div class="duty-translation">${esc(r.translation)}</div>
          </div>`).join("")}
        </div>`;
        }).join("")}
        <div class="mix-sub">典型工作日 · 综合上述职责还原</div>
        <div class="day-box">${esc(ins.typicalDay)}</div>
      </div>

      <div class="card-pair">
        <div class="card">
          <div class="card-head"><span class="t">岗位要求排序</span><span class="h">简历筛选规则、团队优先级与用人偏好</span></div>
          <div class="read-row"><span class="k">机器筛</span><span>${esc(ins.requirementsReading.machineFilter)}</span></div>
          <div class="read-row"><span class="k">排序痛感</span><span>${esc(ins.requirementsReading.priority)}</span></div>
          <div class="read-row"><span class="k">团队气质</span><span>${esc(ins.requirementsReading.temperament)}</span></div>
        </div>
        <div class="card">
          <div class="card-head"><span class="t">加分项解读</span><span class="h">从加分项推断团队的现状与规划</span></div>
          <div class="intel-box">${esc(ins.bonusIntel)}</div>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <span class="t">验证假设</span>
          <span class="h">在面试中向面试官求证上述判断</span>
        </div>
        ${ins.verifyQuestions.map((q) => `<div class="vq-item"><span class="q">?</span><span>${esc(q)}</span></div>`).join("")}
      </div>
    </div>
  `;
}

// ---------- 步骤 3：要求 VS 现状 ----------
const STATUS_TEXT = { met: "✓ 有", partial: "~ 部分", gap: "✗ 缺" };
const VERDICT_CLASS = { "值得投": "go", "改后投": "fix", "观望": "hold", "不建议投": "stop" };

function renderStep3(d) {
  const s = d.screening;
  setRecap("#recap3", d.jdInsight?.teamContext?.oneLiner || "");

  const v = s.verdict;
  if (v) {
    const block = $("#verdictBlock");
    block.className = "verdict " + (VERDICT_CLASS[v.level] || "fix");
    $("#verdictScore").innerHTML = `${v.matchGrade ?? ""}<small> 档</small>`;
    $("#verdictLevel").textContent = v.level;
    $("#verdictReason").textContent = v.reason;
    block.classList.remove("hidden");
    const actions = $("#step3Actions");
    const hasPlan = Array.isArray(currentAnalysis?.editPlan);
    if (hasPlan) {
      actions.innerHTML = '<span style="display:inline-flex;gap:10px;align-items:center;flex-wrap:wrap">' +
        '<button class="btn" id="viewEditPlanBtn">查看修改方案</button>' +
        '<button class="btn ghost" id="genEditPlanBtn">重新生成修改方案</button></span>';
      $("#viewEditPlanBtn").addEventListener("click", () => gotoStep(4));
    } else {
      const positive = v.level === "值得投" || v.level === "改后投";
      actions.innerHTML = positive
        ? '<button class="btn" id="genEditPlanBtn">生成修改方案</button>'
        : '<span style="display:inline-flex;gap:10px;align-items:center;flex-wrap:wrap">' +
          '<button class="btn" data-goto="1">换个 JD</button>' +
          '<button class="btn ghost" id="genEditPlanBtn">仍要生成修改方案</button></span>';
      actions.querySelector("[data-goto]")?.addEventListener("click", () => gotoStep(1));
    }
    $("#genEditPlanBtn").addEventListener("click", requestEditPlan);
  }
  const vsRow = (r) => `
    <div class="vs-row">
      <div class="vs-col">
        <span class="vs-item">${esc(r.item)}</span>
        <div class="vs-why">${esc(r.why)}</div>
      </div>
      <div class="vs-col">
        <span class="badge ${r.status}">${STATUS_TEXT[r.status] || "?"}</span>
        <div class="vs-evidence">${esc(r.evidence)}</div>
      </div>
    </div>`;
  $("#hardReqList").innerHTML = s.hardRequirements.map(vsRow).join("");
  $("#plusReqList").innerHTML = s.plusFactors.map(vsRow).join("");

  const status = d.keywordStatus || [];
  const covMap = new Map(status.map((k) => [k.keyword, k.covered]));
  const renderKw = (list) => list.map((k) => {
    const cov = covMap.get(k);
    const cls = cov === undefined ? "neutral" : cov ? "" : "need";
    const mark = cov === undefined ? "" : cov ? " ✓" : " ✗";
    return `<span class="kw ${cls}">${esc(k)}${mark}</span>`;
  }).join("");
  $("#coreKwList").innerHTML = renderKw(s.coreKeywords);
  $("#plusKwList").innerHTML = renderKw(s.plusKeywords);
  const coreHit = s.coreKeywords.filter((k) => covMap.get(k)).length;
  const plusHit = s.plusKeywords.filter((k) => covMap.get(k)).length;
  $("#coreKwCount").innerHTML = `当前简历已命中 <b>${coreHit}</b>/${s.coreKeywords.length}`;
  $("#plusKwCount").innerHTML = `当前简历已命中 <b>${plusHit}</b>/${s.plusKeywords.length}`;
  $("#narrativeShift").innerHTML = `<b>核心标签：</b>${escTagShift(s.narrativeShift)}`;
}

function escTagShift(text) {
  const m = String(text).match(/^(.+?)(?:→|->|=>|—>|到|改成)(.+)$/);
  if (!m) return esc(text);
  return `<span style="color:#5c616b">${esc(m[1].trim())}</span><span class="arrow">→</span><b>${esc(m[2].trim())}</b>`;
}

function setRecap(sel, text) {
  if (!text) { $(sel).classList.add("hidden"); return; }
  $(sel).innerHTML = `<span class="recap-label">上一步结论</span><b>${esc(text)}</b>`;
  $(sel).classList.remove("hidden");
}

// ---------- 步骤 4：diff ----------
const TYPE_TEXT = { verb: "换动词", order: "调顺序", emphasis: "调重心", keyword: "关键词", tag: "技能tag", "add-from-material": "引入素材", remove: "删除" };

const STRATEGY_TEXT = { light_polish: "措辞微调", refocus: "换主线", restructure: "大改重构" };
const STRUCTURAL_TYPES = new Set(["remove", "add-from-material"]);

function renderStep4(d) {
  setRecap("#recap4", "必命中核心词：" + d.screening.coreKeywords.slice(0, 5).join(" · "));
  const box = $("#diffList");
  box.innerHTML = "";
  const isStruct = d._resumeKind === "structured";
  const st = d.editPlanStrategy;

  if (st) {
    const cuts = (st.cuts || []).map((c) => `<div class="strategy-line cut"><span class="act">删除</span><span class="txt">${esc(c)}</span></div>`).join("");
    const promos = (st.promotions || []).map((p) => `<div class="strategy-line promo"><span class="act">扶正</span><span class="txt">${esc(p)}</span></div>`).join("");
    box.insertAdjacentHTML("beforeend", `
      <div class="strategy-card">
        <div class="strategy-head">
          <span class="strategy-level ${st.level}">${STRATEGY_TEXT[st.level] || st.level}</span>
          <span class="strategy-headline">${esc(st.headline || "")}</span>
        </div>
        ${cuts || promos ? `<div class="strategy-cuts">${cuts}${promos}</div>` : ""}
      </div>`);
  }

  // 结构动作在前、措辞动作在后，分组标头
  const ordered = d.editPlan.map((e, i) => ({ e, i }));
  ordered.sort((a, b) => (STRUCTURAL_TYPES.has(b.e.type) ? 1 : 0) - (STRUCTURAL_TYPES.has(a.e.type) ? 1 : 0));
  let prevGroup = null;
  ordered.forEach(({ e, i }) => {
    const isStructAction = STRUCTURAL_TYPES.has(e.type) || (isStruct && (e.op === "removeExperience" || e.op === "removeBullet" || e.op === "insertBulletAfter"));
    const group = isStructAction ? "struct" : "polish";
    if (group !== prevGroup) {
      prevGroup = group;
      box.insertAdjacentHTML("beforeend", `<div class="diff-group-label">${group === "struct" ? "结构调整 · 删无关 / 补素材" : "措辞调整 · 对齐 JD 关键词"}</div>`);
    }
    renderDiffItem(box, d, e, i, isStruct);
  });
  $("#diffHint").textContent = `${d.editPlan.length} 条修改，已全选`;
}

function renderDiffItem(box, d, e, i, isStruct) {
    const oldText = isStruct ? (e.currentText ?? "") : e.oldText;
    const del = e.type === "add-from-material"
      ? `<span class="diff-empty">（在此处插入新内容）</span>`
      : oldText
        ? `<del class="diff-del">${esc(oldText)}</del>`
        : `<span class="diff-empty">（新增条目）</span>`;
    const insText = isStruct && e.op === "reorderTags" && e.newTags ? e.newTags.join(" / ") : e.newText;
    const ins = e.type === "remove" ? "" : `<ins class="diff-ins" contenteditable="true" data-idx="${i}">${esc(insText)}</ins>`;
    const sectionLabel = isStruct
      ? `${TYPE_TEXT[e.type] || e.type} · ${secLabel(e.section, e)}`
      : `${e.section}`;
    box.insertAdjacentHTML("beforeend", `
      <div class="diff-item" data-idx="${i}">
        <div class="diff-meta">
          <input type="checkbox" checked class="diff-check" data-idx="${i}" aria-label="应用第 ${i + 1} 条修改">
          <span class="diff-section">${esc(sectionLabel)}</span>
          <span class="diff-type">${TYPE_TEXT[e.type] || e.type}</span>
        </div>
        <div class="diff-body">${del}${ins}<div class="diff-reason">${esc(e.reason)}</div>
          <button class="refine-btn" data-idx="${i}">不认同？按我的要求重写</button>
          <div class="refine-box">
            <input type="text" placeholder="如：动词更狠一点 / 突出量化结果 / 删掉后半句" data-idx="${i}">
            <button class="btn" data-refine-go="${i}">重写</button>
            <button class="btn ghost" data-refine-cancel="${i}">取消</button>
          </div>
        </div>
      </div>`);
}

const SECTION_TEXT = { experiences: "经历", projects: "项目", summary: "总结", skills: "技能", education: "教育" };
function secLabel(section, e) {
  const base = SECTION_TEXT[section] || section;
  return typeof e.expIndex === "number" ? `${base} #${e.expIndex + 1}` : base;
}

$("#diffList").addEventListener("click", (e) => {
  const toggle = e.target.closest(".refine-btn");
  if (toggle) {
    const item = toggle.closest(".diff-item");
    const wasOpen = item.classList.contains("refine-open");
    $$("#diffList .diff-item").forEach((d) => d.classList.remove("refine-open"));
    if (!wasOpen) {
      item.classList.add("refine-open");
      item.querySelector(".refine-box input").focus();
    }
    return;
  }
  const cancel = e.target.closest("[data-refine-cancel]");
  if (cancel) cancel.closest(".diff-item").classList.remove("refine-open");
});

$("#diffList").addEventListener("change", (e) => {
  const cb = e.target.closest(".diff-check");
  if (cb) cb.closest(".diff-item").classList.toggle("off", !cb.checked);
  updateDiffHint();
});

$("#diffList").addEventListener("click", async (e) => {
  const go = e.target.closest("[data-refine-go]");
  if (!go) return;
  const idx = Number(go.dataset.refineGo);
  const item = go.closest(".diff-item");
  const input = item.querySelector(".refine-box input");
  const requirement = input.value.trim();
  if (!requirement) { input.focus(); return; }
  go.disabled = true;
  go.textContent = "重写中…";
  try {
    const ins = item.querySelector(".diff-ins[contenteditable]");
    const currentEdit = {
      ...currentAnalysis.editPlan[idx],
      newText: ins ? ins.textContent : currentAnalysis.editPlan[idx].newText,
    };
    const data = await llmFetch("/api/refine-edit", {
      jdText: $("#jdText").value.trim(), edit: currentEdit, requirement,
    });
    if (ins) ins.textContent = data.newText;
    item.querySelector(".diff-reason").textContent = data.reason;
    item.classList.remove("refine-open");
    input.value = "";
  } catch (err) {
    showError("#applyError", err.message);
  } finally {
    go.disabled = false;
    go.textContent = "重写";
  }
});

function updateDiffHint() {
  const total = $$("#diffList .diff-check").length;
  const checked = $$("#diffList .diff-check:checked").length;
  $("#diffHint").textContent = `${checked}/${total} 条已选`;
}

$("#modeToggle").addEventListener("click", (e) => {
  if (e.target.tagName !== "BUTTON") return;
  applyMode = e.target.dataset.mode;
  $$("#modeToggle button").forEach((b) => b.classList.toggle("active", b === e.target));
  $("#companyName").classList.toggle("hidden", applyMode !== "new");
});

// ---------- 应用（客户端存 IndexedDB） ----------
$("#applyBtn").addEventListener("click", async () => {
  if (!currentAnalysis) return;
  const edits = [];
  $$("#diffList .diff-item").forEach((item) => {
    const cb = item.querySelector(".diff-check");
    if (!cb.checked) return;
    const idx = Number(cb.dataset.idx);
    const ins = item.querySelector(".diff-ins[contenteditable]");
    const newText = ins ? ins.textContent : "";
    const edit = { ...currentAnalysis.editPlan[idx], newText };
    if (currentAnalysis._resumeKind === "structured" && edit.op === "reorderTags" && ins) {
      edit.newTags = ins.textContent.split(/[\/、,，]/).map((s) => s.trim()).filter(Boolean);
    }
    edits.push(edit);
  });
  if (edits.length === 0) { showError("#applyError", "没有勾选任何修改条目"); return; }
  if (applyMode === "new" && !$("#companyName").value.trim()) { showError("#applyError", "请填写公司名（用于新版本命名）"); return; }
  const baseResume = await currentResume();
  if (!baseResume) { showError("#applyError", "base 简历不存在"); return; }
  $("#applyError").classList.add("hidden");
  $("#applyBtn").disabled = true;
  $("#applyBtn").textContent = "应用中…";
  try {
    const isStruct = baseResume.kind === "structured";
    // 结构化简历的编辑可能已被用户在 diff 里改过 newText；reorderTags 用编辑后的 tags 序列
    const payload = isStruct
      ? { resume: baseResume.data, edits, keywords: { core: currentAnalysis.screening.coreKeywords, plus: currentAnalysis.screening.plusKeywords } }
      : { resumeHtml: baseResume.html, edits, keywords: { core: currentAnalysis.screening.coreKeywords, plus: currentAnalysis.screening.plusKeywords } };
    const res = await fetch(isStruct ? "/api/apply-structured" : "/api/apply-edits", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "应用失败");

    // 落入 IndexedDB
    const now = new Date().toISOString();
    if (applyMode === "new") {
      const company = $("#companyName").value.trim();
      const record = {
        id: uuid(),
        name: `${baseResume.name}·${company}`,
        ...(isStruct ? { kind: "structured", data: data.resume } : { kind: "html", html: data.html }),
        createdAt: now, updatedAt: now,
        derivedFrom: baseResume.id,
      };
      await dbPut("resumes", record);
      appliedResumeName = record.name;
    } else {
      await dbPut("resumes", { ...baseResume, ...(isStruct ? { data: data.resume } : { html: data.html }), updatedAt: now });
      appliedResumeName = baseResume.name;
    }
    await loadResumes();
    lastAppliedResult = data;
    lastAppliedKind = isStruct ? "structured" : "html";
    if (isStruct) appliedStructuredData = data.resume;
    renderResult(data);
    gotoStep(5);
  } catch (err) {
    showError("#applyError", err.message);
  } finally {
    $("#applyBtn").disabled = false;
    $("#applyBtn").textContent = "应用修改";
  }
});

function renderResult(d) {
  $("#resultSummary").innerHTML = `已保存为 <b>${esc(appliedResumeName)}</b>（简历库可见）`;
  $("#statApplied").textContent = d.appliedCount;
  $("#statSkipped").textContent = d.skippedCount;
  const list = $("#applyResultList");
  list.innerHTML = "";
  d.results.forEach((r) => {
    list.insertAdjacentHTML("beforeend", `<div class="apply-result-row">
      <div>${esc(r.section)}：${esc(r.oldText.slice(0, 34))}${r.oldText.length > 34 ? "…" : ""} → ${esc(r.newText.slice(0, 34))}${r.newText.length > 34 ? "…" : ""}${r.note ? `<div class="vs-why">${esc(r.note)}</div>` : ""}</div>
      <div>${r.status === "applied" ? '<span class="status-applied">✓ 应用</span>' : '<span class="status-skipped">✗ 跳过</span>'}</div>
    </div>`);
  });
  const core = d.keywordCoverage.filter((k) => k.category === "core");
  const plus = d.keywordCoverage.filter((k) => k.category === "plus");
  const hit = core.filter((k) => k.covered).length;
  $("#statCoverage").textContent = core.length ? Math.round((hit / core.length) * 100) + "%" : "—";
  $("#coverageList").innerHTML =
    core.map((k) => `<span class="kw ${k.covered ? "" : "need"}">${esc(k.keyword)} ${k.covered ? "✓" : "✗"}</span>`).join("") +
    plus.map((k) => `<span class="kw ${k.covered ? "" : "need"}" style="opacity:.75">${esc(k.keyword)} ${k.covered ? "✓" : "✗"}</span>`).join("");
  // 预览：HTML 用 srcdoc；结构化用渲染后的预览页
  if (lastAppliedKind === "structured" && appliedStructuredData) {
    appliedHtml = structuredPreviewHtml(appliedStructuredData, appliedResumeName);
  } else {
    appliedHtml = d.html;
  }
  $("#preview").srcdoc = appliedHtml;
}

// 结构化简历 → 简单预览 HTML（预览/下载 HTML 共用）
function structuredPreviewHtml(data, name) {
  const esc2 = esc;
  const parts = [];
  parts.push(`<h1>${esc2(data.name || name || "")}</h1>`);
  const c = [data.contact?.email, data.contact?.phone, ...(data.contact?.links || [])].filter(Boolean);
  if (c.length) parts.push(`<p>${c.map(esc2).join(" · ")}</p>`);
  if (data.summary) parts.push(`<h2>Summary</h2><p>${esc2(data.summary)}</p>`);
  if (data.education?.length) {
    parts.push(`<h2>Education</h2>`);
    data.education.forEach((e) => parts.push(`<p><b>${esc2(e.school)}</b>${e.degree ? " · " + esc2(e.degree) : ""}${e.major ? " · " + esc2(e.major) : ""}${e.period ? "（" + esc2(e.period) + "）" : ""}</p>`));
  }
  const sec = (title, arr) => {
    if (!arr?.length) return;
    parts.push(`<h2>${title}</h2>`);
    arr.forEach((x) => {
      parts.push(`<p><b>${esc2(x.org || x.name || "")}</b>${x.role ? " · " + esc2(x.role) : ""}${x.period ? "（" + esc2(x.period) + "）" : ""}</p><ul>`);
      (x.bullets || []).forEach((b) => parts.push(`<li>${esc2(b)}</li>`));
      if (x.tags?.length) parts.push(`<li><i>${x.tags.map(esc2).join(" / ")}</i></li>`);
      parts.push(`</ul>`);
    });
  };
  sec("Experience", data.experiences);
  sec("Projects", data.projects);
  if (data.skills) {
    parts.push(`<h2>Skills</h2>`);
    if (Array.isArray(data.skills)) parts.push(`<p>${data.skills.map(esc2).join(" / ")}</p>`);
    else data.skills.groups?.forEach((g) => parts.push(`<p><b>${esc2(g.label)}：</b>${g.items.map(esc2).join(" / ")}</p>`));
  }
  if (data.honors?.length) parts.push(`<h2>Honors</h2><ul>${data.honors.map((h) => `<li>${esc2(h)}</li>`).join("")}</ul>`);
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>${esc2(name || "简历")}</title><style>body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;max-width:760px;margin:40px auto;padding:0 24px;color:#18191b;line-height:1.6}h1{font-size:26px;margin-bottom:4px}h2{font-size:15px;border-bottom:1px solid #d8dade;padding-bottom:4px;margin-top:28px;letter-spacing:.5px}p{margin:6px 0}ul{margin:6px 0 12px;padding-left:20px}</style></head><body>${parts.join("\n")}</body></html>`;
}

$("#downloadBtn").addEventListener("click", async () => {
  if (!appliedResumeName) return;
  if (lastAppliedKind === "structured" && appliedStructuredData) {
    downloadStructuredPdf({ name: appliedResumeName, data: appliedStructuredData });
    return;
  }
  if (appliedHtml) downloadText(appliedHtml, appliedResumeName + ".html");
});

$("#openPreview").addEventListener("click", () => {
  if (!appliedHtml) return;
  const blob = new Blob([appliedHtml], { type: "text/html" });
  window.open(URL.createObjectURL(blob), "_blank");
});

// ---------- 投递看板 ----------
async function loadTrack() {
  trackApps = (await dbGetAll("applications")).sort((a, b) => (a.appliedAt < b.appliedAt ? 1 : -1));
  renderFunnel();
  renderTrackFilters();
  renderTrackList();
}

function renderFunnel() {
  const box = $("#funnel");
  if (trackApps.length === 0) { box.innerHTML = ""; box.style.display = "none"; return; }
  box.style.display = "";
  const count = (s) => trackApps.filter((a) => a.status === s).length;
  // 漏斗口径：进入过该轮及以后的数量（投过=全部；offer/rejected 终态）
  const reached = (s) => trackApps.filter((a) => {
    const idx = (x) => TRACK_STATUSES.indexOf(x);
    return idx(a.status) >= idx(s) || a.status === "offer";
  }).length;
  const cells = [
    { v: trackApps.length, l: "投递", cls: "" },
    { v: count("screening") + count("interview1") + count("interview2") + count("hr") + count("offer"), l: "进入流程", cls: "" },
    { v: count("interview1") + count("interview2") + count("hr") + count("offer"), l: "过初筛", cls: "" },
    { v: count("interview2") + count("hr") + count("offer"), l: "过一面", cls: "" },
    { v: count("hr") + count("offer"), l: "过二面", cls: "" },
    { v: count("offer"), l: "Offer", cls: "hot" },
    { v: count("rejected"), l: "挂了", cls: "dead" },
  ];
  box.innerHTML = cells.map((c) => `<div class="funnel-cell ${c.cls}"><div class="fv">${c.v}</div><div class="fl">${c.l}</div></div>`).join("");
}

function renderTrackFilters() {
  const counts = { all: trackApps.length };
  TRACK_STATUSES.forEach((s) => { counts[s] = trackApps.filter((a) => a.status === s).length; });
  const box = $("#trackFilters");
  box.innerHTML = "";
  const mk = (key, label) => {
    const n = counts[key] ?? 0;
    const b = document.createElement("button");
    b.className = "filter-chip" + (trackFilter === key ? " on" : "");
    b.textContent = `${label}${n ? " " + n : ""}`;
    b.addEventListener("click", () => { trackFilter = key; renderTrackFilters(); renderTrackList(); });
    box.appendChild(b);
  };
  mk("all", "全部");
  TRACK_STATUSES.forEach((s) => { if (counts[s]) mk(s, STATUS_LABEL[s]); });
}

function renderTrackList() {
  const list = $("#appList");
  const empty = $("#trackEmpty");
  const shown = trackFilter === "all" ? trackApps : trackApps.filter((a) => a.status === trackFilter);
  empty.style.display = trackApps.length === 0 ? "" : "none";
  list.innerHTML = "";
  shown.forEach((a) => {
    const div = document.createElement("div");
    div.className = "app-row";
    div.innerHTML = `
      <div class="app-row-top">
        <span class="app-company">${esc(a.company)}</span>
        <span class="app-role">${esc(a.role)}</span>
        <span class="app-score">${a.analysisSnapshot?.screening?.verdict ? a.analysisSnapshot.screening.verdict.matchGrade + " 档 · " + a.analysisSnapshot.screening.verdict.level : ""}</span>
      </div>
      <div class="app-row-bottom">
        <span class="st-badge ${a.status}">${STATUS_LABEL[a.status] || a.status}</span>
        <span class="app-date">${esc(a.appliedAt)}</span>
        ${a.interviewPrep ? '<span style="font-size:11px;color:#168a5f;font-weight:600">面试准备 ✓</span>' : ""}
      </div>`;
    div.addEventListener("click", () => { trackOpenId = trackOpenId === a.id ? null : a.id; renderTrackList(); });
    list.appendChild(div);
    if (trackOpenId === a.id) renderTrackDetail(a, div);
  });
}

async function patchApp(id, patch) {
  const a = await dbGet("applications", id);
  if (!a) return null;
  const updated = { ...a, ...patch };
  await dbPut("applications", updated);
  return updated;
}

async function renderTrackDetail(a, anchorRow) {
  const detail = document.createElement("div");
  detail.className = "card track-detail";
  detail.innerHTML = `
    <div class="detail-grid">
      <div>
        <div class="sec-label" style="margin-top:0">JD 原文</div>
        <div class="jd-fold" id="jdFold">${esc(a.jdText)}</div>
        <button class="jd-toggle" id="jdToggle">展开全部</button>
        <div id="prepSection">${a.interviewPrep && a.interviewPrep.round
          ? renderPrep(a.interviewPrep, a.practicedIds || [])
          : ""}</div>
      </div>
      <div style="display:grid;gap:12px;align-content:start">
        <div class="card side-card">
          <div class="sec-label" style="margin-top:0">状态</div>
          <select class="status-select" id="stSel">
            ${TRACK_STATUSES.map((s) => `<option value="${s}" ${s === a.status ? "selected" : ""}>${STATUS_LABEL[s]}</option>`).join("")}
          </select>
          <div class="sec-label" style="margin:14px 0 4px">进展记录</div>
          ${a.timeline.slice().reverse().map((t) => `<div class="tl-item"><span class="tl-dot"></span><span><span class="tl-date">${esc(t.date)}</span> ${esc(t.event)}</span></div>`).join("")}
        </div>
        <div class="card side-card">
          <div class="sec-label" style="margin-top:0">备注</div>
          <textarea class="notes-area" id="notesArea" placeholder="内推人 / 投递渠道 / 面试感受……">${esc(a.notes || "")}</textarea>
        </div>
        <div class="card side-card">
          <div class="sec-label" style="margin-top:0">面试准备</div>
          ${a.interviewPrep && a.interviewPrep.round ? `<div style="font-size:12px;color:#168a5f;font-weight:600;margin-bottom:8px">已备 ${ROUND_NAME[a.interviewPrep.round] || "?"}</div>` : ""}
          <div class="round-picker">
            <button class="round-pick-btn primary" data-round="interview1">备一面</button>
            <button class="round-pick-btn" data-round="interview2">备二面</button>
            <button class="round-pick-btn" data-round="hr">备 HR</button>
          </div>
          <button class="btn danger" id="delBtn" style="width:100%;margin-top:10px">删除记录</button>
        </div>
      </div>
    </div>`;
  anchorRow.after(detail);

  $("#jdToggle").addEventListener("click", () => {
    const fold = $("#jdFold");
    fold.classList.toggle("open");
    $("#jdToggle").textContent = fold.classList.contains("open") ? "收起" : "展开全部";
  });
  $("#stSel").addEventListener("change", async (e) => {
    const status = e.target.value;
    await patchApp(a.id, {
      status,
      timeline: [...a.timeline, { date: today(), event: "状态变更为「" + STATUS_LABEL[status] + "」" }],
    });
    loadTrack();
  });
  let notesTimer;
  $("#notesArea").addEventListener("input", (e) => {
    clearTimeout(notesTimer);
    notesTimer = setTimeout(() => patchApp(a.id, { notes: e.target.value }), 600);
  });
  $$(".round-pick-btn").forEach((b) => {
    b.addEventListener("click", async () => {
      const round = b.dataset.round;
      const target = a.interviewPrep && a.interviewPrep.round === round;
      if (target && !confirm(`当前已有${ROUND_NAME[round]}的准备，重新生成会覆盖（含演练进度），继续？`)) return;
      await generatePrep(a.id, round, target);
    });
  });
  $("#delBtn").addEventListener("click", async () => {
    if (!confirm(`删除「${a.company} · ${a.role}」的投递记录？不可恢复。`)) return;
    await dbDelete("applications", a.id);
    trackOpenId = null;
    loadTrack();
  });
  bindPrepPractice(a.id);
}

const today = () => new Date().toISOString().slice(0, 10);

async function generatePrep(id, round, isRegen) {
  const a = await dbGet("applications", id);
  if (!a) return;
  $$(".round-pick-btn").forEach((b) => { b.disabled = true; });
  const clicked = $(`.round-pick-btn[data-round="${round}"]`);
  const oldText = clicked.textContent;
  clicked.textContent = "生成中…";
  try {
    // 无快照先补阶段 1 分析（对用户透明），再生成 prep
    let snapshot = a.analysisSnapshot;
    if (!snapshot) {
      const resume = a.resumeId ? await dbGet("resumes", a.resumeId) : null;
      const resumeText = resume ? (resume.kind === "structured" ? structuredToText(resume.data) : resume.html) : "";
      const { materials } = await currentMaterials();
      snapshot = await llmFetch("/api/analyze", {
        jdText: a.jdText,
        resumeHtml: resumeText,
        materials, hiddenPool: "",
      });
    }
    const resume = a.resumeId ? await dbGet("resumes", a.resumeId) : null;
    const resumeText = resume ? (resume.kind === "structured" ? structuredToText(resume.data) : resume.html) : "";
    const { materials } = await currentMaterials();
    const prep = await llmFetch("/api/prep", {
      jdText: a.jdText,
      resumeHtml: resumeText,
      materials,
      targetRound: round,
      analysisSnapshot: snapshot,
    });
    await patchApp(id, { interviewPrep: prep, practicedIds: [], analysisSnapshot: snapshot });
    trackOpenId = id;
    await loadTrack();
  } catch (err) {
    alert(err.message);
    clicked.textContent = oldText;
    $$(".round-pick-btn").forEach((b) => { b.disabled = false; });
  }
}

// ---------- prep 渲染 ----------
const ROUND_NAME = { interview1: "一面 · 挖简历", interview2: "二面 · 判断力", hr: "HR 面 · 动机" };

function fold(title, count, body, open) {
  return `<details class="fold"${open ? " open" : ""}>
    <summary>${esc(title)}${count != null ? ` <span class="fold-n">${count}</span>` : ""}<span class="chev">▶</span></summary>
    <div class="fold-body">${body}</div>
  </details>`;
}

function renderPrep(p, practiced) {
  const currentPracticed = practiced || [];
  const drillBody = p.drillCards.map((c) => `
    <div class="drill-card" data-card="${esc(c.id)}">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px">
        <span class="drill-bullet">${esc(c.bullet)}</span>
        <label style="display:inline-flex;gap:5px;align-items:center;font-size:12px;color:#8a8f98;cursor:pointer;flex:none"><input type="checkbox" class="drill-check" data-card="${esc(c.id)}" ${currentPracticed.includes(c.id) ? "checked" : ""}>已演练</label>
      </div>
      <div class="drill-layer"><span class="k">结果</span><span>${esc(c.drill.result)}</span></div>
      <div class="drill-layer"><span class="k">过程</span><span>${esc(c.drill.process)}</span></div>
      <div class="drill-layer"><span class="k">反思</span><span>${esc(c.drill.reflection)}</span></div>
      ${(c.followUps || []).map((f) => `<div class="followup">${esc(f.q)}<span style="color:#5c616b"> — ${esc(f.howToCatch)}</span></div>`).join("")}
    </div>`).join("");

  const introBody = `
    <div class="narrative" style="margin:0 0 4px"><b>主线：</b>${esc(p.selfIntro.narrative)}</div>
    ${p.selfIntro.segments.map((s) => `<div class="seg-item"><span class="seg-hook">${esc(s.hook)}</span><div>${esc(s.points)}</div></div>`).join("")}`;

  const qBody = p.likelyQuestions.map((q) => `<div class="q-item"><div class="q-text">${esc(q.q)}</div><div class="q-frame">${esc(q.framework)}</div></div>`).join("");

  return `
    <div style="margin-top:20px">
      <span class="prep-round-badge">${ROUND_NAME[p.round] || p.round}</span>
      <div class="prep-focus">${esc(p.focus)}</div>
      ${fold("项目下钻卡", `${currentPracticed.length}/${p.drillCards.length} 已演练`, drillBody, true)}
      ${fold("自我介绍 · 60 秒", null, introBody, false)}
      ${fold("这一轮高频题", p.likelyQuestions.length, qBody, false)}
      ${p.gapDefenses.length ? fold("gap 防御卡", p.gapDefenses.length, p.gapDefenses.map((g) => `<div class="ammo-item"><b>${esc(g.gap)}</b><div style="margin-top:2px">${esc(g.script)}</div></div>`).join(""), false) : ""}
      ${fold("反问清单", p.counterQuestions.length, p.counterQuestions.map((q) => `<div class="vq-item"><span class="q">?</span><span>${esc(q)}</span></div>`).join(""), false)}
      ${fold("面试前一天清单", p.dayBeforeChecklist.length, p.dayBeforeChecklist.map((c) => `<div class="check-item">${esc(c)}</div>`).join(""), false)}
    </div>`;
}

function bindPrepPractice(appId) {
  $$(".drill-check").forEach((cb) => {
    cb.addEventListener("change", async () => {
      const practiced = Array.from($$(".drill-check:checked")).map((c) => c.dataset.card);
      await patchApp(appId, { practicedIds: practiced });
    });
  });
}

// ---------- 手动新建 ----------
$("#newAppBtn").addEventListener("click", () => {
  $("#newAppForm").classList.toggle("hidden");
  $("#naDate").value = today();
  const sel = $("#naResume");
  sel.innerHTML = '<option value="">（不关联）</option>' + resumes.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join("");
});
$("#naCancel").addEventListener("click", () => $("#newAppForm").classList.add("hidden"));
$("#naSave").addEventListener("click", async () => {
  const company = $("#naCompany").value.trim();
  const role = $("#naRole").value.trim();
  const jdText = $("#naJdText").value.trim();
  if (!company || !role || !jdText) { showError("#naError", "公司、岗位、JD 都要填"); return; }
  $("#naError").classList.add("hidden");
  const record = {
    id: uuid(),
    company, role, jdText,
    resumeId: $("#naResume").value || undefined,
    resumeName: $("#naResume").value ? (resumes.find((r) => r.id === $("#naResume").value)?.name) : undefined,
    appliedAt: $("#naDate").value || today(),
    status: "applied",
    timeline: [{ date: today(), event: "创建投递记录" }],
    notes: "",
  };
  await dbPut("applications", record);
  $("#newAppForm").classList.add("hidden");
  $("#naJdText").value = ""; $("#naCompany").value = ""; $("#naRole").value = "";
  loadTrack();
});

// ---------- 向导第 5 步：一键记录投递 ----------
$("#recordApplyBtn").addEventListener("click", async () => {
  if (!currentAnalysis) return;
  const company = ($("#companyName").value.trim() || currentAnalysis.position.company || "").trim();
  if (!company || company === "目标公司") {
    $("#recordApplyBtn").textContent = "先在上面填公司名";
    setTimeout(() => { $("#recordApplyBtn").textContent = "记录这次投递"; }, 1500);
    return;
  }
  const btn = $("#recordApplyBtn");
  btn.disabled = true;
  btn.textContent = "记录中…";
  try {
    const baseResume = await currentResume();
    const record = {
      id: uuid(),
      company,
      role: currentAnalysis.position.role || "未命名岗位",
      jdText: $("#jdText").value.trim(),
      resumeId: currentAnalysis._resumeId,
      resumeName: baseResume?.name,
      appliedAt: today(),
      status: "applied",
      timeline: [{ date: today(), event: "创建投递记录" }],
      notes: "",
      analysisSnapshot: currentAnalysis,
    };
    await dbPut("applications", record);
    btn.textContent = "已记录 ✓（投递看板可见）";
    toast("已记录到投递看板");
  } catch (err) {
    alert(err.message);
    btn.disabled = false;
    btn.textContent = "记录这次投递";
  }
});

// ---------- 设置 ----------
let providers = [];
let selectedProvider = "deepseek";

async function loadSettings() {
  const s = await getLlmSettings();
  if (s) {
    selectedProvider = s.provider || "custom";
    $("#llmBaseUrl").value = s.baseUrl || "";
    $("#llmModel").value = s.model || "";
    $("#llmApiKey").value = s.apiKey || "";
  }
  renderProviderCards();
}

function renderProviderCards() {
  const box = $("#providerCards");
  box.innerHTML = "";
  providers.forEach((p) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "radio-card" + (selectedProvider === p.id ? " sel" : "");
    b.innerHTML = `${esc(p.label)}<span class="rc-sub">${p.defaultModel || "自填地址与模型"}</span>`;
    b.addEventListener("click", () => {
      selectedProvider = p.id;
      if (p.baseUrl) $("#llmBaseUrl").value = p.baseUrl;
      if (p.defaultModel) $("#llmModel").value = p.defaultModel;
      $("#customBaseUrlField").classList.toggle("hidden", p.id !== "custom");
      renderProviderCards();
    });
    box.appendChild(b);
  });
  $("#customBaseUrlField").classList.toggle("hidden", selectedProvider !== "custom");
}

function debounceSave(sel, saveFn, hintSel) {
  const el = $(sel);
  const hint = $(hintSel);
  if (el.dataset.bound) return;
  el.dataset.bound = "1";
  let timer;
  el.addEventListener("input", () => {
    hint.style.visibility = "hidden";
    clearTimeout(timer);
    timer = setTimeout(async () => {
      await saveFn();
      hint.style.visibility = "visible";
    }, 600);
  });
}

$("#keyToggle").addEventListener("click", () => {
  const input = $("#llmApiKey");
  const show = input.type === "password";
  input.type = show ? "text" : "password";
  $("#keyToggle").textContent = show ? "隐藏" : "显示";
});

function collectLlmSettings() {
  const p = providers.find((x) => x.id === selectedProvider) || {};
  return {
    provider: selectedProvider,
    baseUrl: $("#llmBaseUrl").value.trim(),
    model: $("#llmModel").value.trim(),
    apiKey: $("#llmApiKey").value.trim(),
    supportsJsonSchema: p.supportsJsonSchema !== false,
  };
}

$("#llmSaveBtn").addEventListener("click", async () => {
  const s = collectLlmSettings();
  if (!s.baseUrl || !s.model || !s.apiKey) { showError("#llmError", "API 地址、模型、Key 都要填"); return; }
  $("#llmError").classList.add("hidden");
  await dbPut("settings", { key: "llm", ...s });
  $("#llmSaved").style.visibility = "visible";
  setTimeout(() => { $("#llmSaved").style.visibility = "hidden"; }, 1800);
  await refreshNavStatus();
  toast("模型设置已保存，分析功能即可使用");
});

$("#llmPingBtn").addEventListener("click", async () => {
  const s = collectLlmSettings();
  if (!s.baseUrl || !s.model || !s.apiKey) { showError("#llmError", "先填好 API 地址、模型和 Key"); return; }
  $("#llmError").classList.add("hidden");
  const btn = $("#llmPingBtn");
  btn.disabled = true;
  btn.textContent = "测试中…";
  $("#pingResult").textContent = "";
  try {
    const res = await fetch("/api/llm-ping", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-llm-key": s.apiKey, "x-llm-base-url": s.baseUrl, "x-llm-model": s.model,
      },
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "连接失败");
    $("#pingResult").innerHTML = '<span style="color:#168a5f;font-weight:600">连接成功 ✓</span>';
  } catch (err) {
    $("#pingResult").innerHTML = `<span style="color:#b3372e">${esc(err.message)}</span>`;
  } finally {
    btn.disabled = false;
    btn.textContent = "测试连接";
  }
});

// ---------- 数据导出/导入 ----------
$("#exportBtn").addEventListener("click", async () => {
  const data = {
    version: 1,
    exportedAt: new Date().toISOString(),
    resumes: await dbGetAll("resumes"),
    applications: await dbGetAll("applications"),
    materials: await dbGetAll("materials"),
    settings: await dbGetAll("settings"),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `resume-tailor-backup-${today()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
});

$("#importBtn").addEventListener("click", () => $("#importFileInput").click());
$("#importFileInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data || typeof data !== "object" || !Array.isArray(data.resumes)) throw new Error("不是有效的备份文件");
    if (!confirm(`导入 ${data.resumes.length} 份简历、${(data.applications || []).length} 条投递记录？现有同名数据会被覆盖。`)) return;
    for (const r of data.resumes) await dbPut("resumes", r);
    for (const a of data.applications || []) await dbPut("applications", a);
    for (const m of data.materials || []) await dbPut("materials", m);
    for (const s of data.settings || []) await dbPut("settings", s);
    await loadResumes();
    await refreshAnalyzeEntry();
    await refreshNavStatus();
    toast("导入完成");
    loadSettings();
  } catch (err) {
    showError("#dataError", err.message);
  }
});

$("#wipeBtn").addEventListener("click", async () => {
  if (!confirm("清空全部数据（简历、素材、投递记录、设置）？此操作不可恢复。建议先导出备份。")) return;
  if (!confirm("再次确认：真的要清空所有数据？")) return;
  for (const s of STORES) await dbClear(s);
  location.reload();
});

// ---------- 初始化 ----------
(async function init() {
  try {
    await openDb();
  } catch (err) {
    toast("浏览器存储不可用：" + err.message, true);
    return;
  }
  // 旧素材文本一次性迁移为 note 卡（空不建）
  const legacy = await dbGet("materials", "materials");
  const cardsRow = await dbGet("materials", "cards");
  if (legacy?.text?.trim() && !cardsRow) {
    await dbPut("materials", { key: "cards", cards: [{ id: uuid(), type: "note", title: "（从旧素材库迁移）", text: legacy.text, createdAt: new Date().toISOString() }] });
    toast("旧素材库内容已迁移为一张「随手记」卡，在「我的档案」里查看");
  }
  // 隐藏经历池：加载 + 绑定保存（我的档案页）
  const h = await dbGet("materials", "hiddenPool");
  $("#hiddenPoolText").value = h?.text || "";
  bindPoolSave();

  const res = await fetch("/api/meta");
  META = await res.json();
  if (META.providers) providers = META.providers;
  if (META.statusLabels) STATUS_LABEL = META.statusLabels;
  await loadResumes();
  await refreshAnalyzeEntry();
  await refreshNavStatus();
  renderRail(1);

  // hash 路由
  const hash = location.hash.replace("#", "");
  if (["profile", "track", "settings"].includes(hash)) switchView(hash);
})();
