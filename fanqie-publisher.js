#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const readline = require("readline/promises");
const { stdin: input, stdout: output } = require("process");
const { chromium } = require("playwright");

const DEFAULT_CHAPTERS_DIR = "";
const USER_DATA_DIR = path.join(process.cwd(), ".fanqie-browser-profile");
const RUNS_DIR = path.join(process.cwd(), ".fanqie-runs");
const DEFAULT_MIN_CHARS = 1000;
const EDGE_PATHS = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];

function parseArgs(argv) {
  const args = {
    chapters: DEFAULT_CHAPTERS_DIR,
    config: "",
    book: "",
    start: 1,
    end: Infinity,
    mode: "draft",
    delay: 1200,
    url: "https://fanqienovel.com/writer/zone",
    newUrl: "",
    backendBook: "",
    headless: false,
    minChars: DEFAULT_MIN_CHARS,
    confirmEach: false,
    confirmEvery: 0,
    resume: true,
    reset: false,
    dryRun: false,
    strictQuality: true,
    inspect: false,
    autoStart: false,
    publishDrafts: false,
    uploadAndPublish: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const key = argv[i];
    const next = argv[i + 1];
    if (key === "--chapters" && next) args.chapters = path.resolve(next), i++;
    else if (key === "--config" && next) args.config = path.resolve(next), i++;
    else if (key === "--book" && next) args.book = next, i++;
    else if (key === "--start" && next) args.start = Number(next), i++;
    else if (key === "--end" && next) args.end = Number(next), i++;
    else if (key === "--url" && next) args.url = next, i++;
    else if (key === "--new-url" && next) args.newUrl = next, i++;
    else if (key === "--backend-book" && next) args.backendBook = next, i++;
    else if (key === "--delay" && next) args.delay = Number(next), i++;
    else if (key === "--mode" && next) args.mode = next, i++;
    else if (key === "--min-chars" && next) args.minChars = Number(next), i++;
    else if (key === "--confirm-each") args.confirmEach = true;
    else if (key === "--confirm-every" && next) args.confirmEvery = Number(next), i++;
    else if (key === "--no-resume") args.resume = false;
    else if (key === "--reset") args.reset = true;
    else if (key === "--dry-run") args.dryRun = true, args.mode = "dry-run";
    else if (key === "--publish") args.mode = "publish";
    else if (key === "--upload-and-publish") args.uploadAndPublish = true, args.mode = "upload-and-publish";
    else if (key === "--draft") args.mode = "draft";
    else if (key === "--no-strict-quality") args.strictQuality = false;
    else if (key === "--inspect-page") args.inspect = true;
    else if (key === "--auto-start") args.autoStart = true;
    else if (key === "--publish-drafts") args.publishDrafts = true, args.mode = "publish-drafts";
    else if (key === "--headless") args.headless = true;
    else if (key === "--help" || key === "-h") args.help = true;
  }

  if (!["dry-run", "draft", "publish", "publish-drafts", "upload-and-publish"].includes(args.mode)) {
    throw new Error("--mode 只能是 dry-run、draft、publish、publish-drafts 或 upload-and-publish");
  }
  return args;
}

function loadConfig(configPath) {
  if (!configPath) return {};
  if (!fs.existsSync(configPath)) throw new Error(`配置文件不存在：${configPath}`);
  const raw = fs.readFileSync(configPath, "utf8");
  return JSON.parse(raw);
}

function normalizeArgs(args) {
  const config = loadConfig(args.config);
  const merged = { ...args };
  for (const key of [
    "chapters",
    "book",
    "url",
    "newUrl",
    "backendBook",
    "minChars",
    "delay",
    "confirmEvery",
  ]) {
    if ((merged[key] === "" || merged[key] === 0 || merged[key] === DEFAULT_MIN_CHARS) && config[key] !== undefined) {
      merged[key] = config[key];
    }
  }
  if (config.confirmEach && !args.confirmEach) merged.confirmEach = true;
  if (config.strictQuality === false) merged.strictQuality = false;
  if (config.autoStart && !args.autoStart) merged.autoStart = true;
  if (merged.chapters) merged.chapters = path.resolve(merged.chapters);
  if (!merged.book && merged.chapters) {
    const normalized = path.resolve(merged.chapters);
    const base = path.basename(normalized).toLowerCase() === "chapters"
      ? path.basename(path.dirname(normalized))
      : path.basename(normalized);
    merged.book = base;
  }
  if (!merged.backendBook && merged.url) merged.backendBook = extractBackendBookFromUrl(merged.url);
  return merged;
}

function extractBackendBookFromUrl(url) {
  try {
    const pathname = new URL(String(url)).pathname;
    const raw = pathname.split("/").pop() || "";
    const marker = raw.includes("&") ? raw.split("&").slice(1).join("&") : "";
    return decodeURIComponent(marker).trim();
  } catch {
    return "";
  }
}

function printHelp() {
  console.log(`
番茄发布助手 CLI

用法：
  npm run fanqie -- --chapters "D:\\novels\\某本书\\chapters" --dry-run --start 1 --end 10
  npm run fanqie -- --chapters "D:\\novels\\某本书\\chapters" --draft --start 1 --end 3
  npm run fanqie -- --config ".\\fanqie.config.json" --draft --start 1 --end 3

常用参数：
  --chapters        章节目录，通常指向某本书的 chapters 文件夹
  --config          JSON 配置文件，可保存 book、chapters、newUrl 等
  --book            书名，用于日志和断点标识；不传时从 chapters 路径推断
  --start           起始章节号，默认 1
  --end             结束章节号，默认全部
  --dry-run         只做本地检查，不打开浏览器，不填后台
  --draft           保存草稿模式，默认模式
  --publish         正式发布模式
  --upload-and-publish 填写章节后直接发布
  --publish-drafts  从草稿箱/章节管理页按章节范围发布已存在草稿
  --confirm-each    每章填完后暂停确认
  --confirm-every   每 N 章暂停确认一次
  --reset           清空本次范围的断点记录，从头处理
  --no-resume       忽略断点记录，但不删除记录文件
  --min-chars       最低有效字数，默认 1000
  --delay           每章提交后等待毫秒数，默认 1200
  --url             打开的后台地址
  --new-url         真正的新建章节 URL。保存后每章用它打开新页面，避免复制编辑草稿 URL
  --inspect-page    登录并进入编辑页后，只导出页面诊断，不填写内容

流程：
  1. 先用 --chapters 或 --config 指定要发布的小说。
  2. 运行 --dry-run 检查章节质量。
  3. 再运行 --draft 保存少量章节为草稿。
  4. 确认后台显示正常后，再扩大范围或使用 --publish。
`);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function safeName(text) {
  return String(text).replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 120);
}

function normalizeDigitText(value) {
  return String(value || "").replace(/[０-９]/g, (char) => String(char.charCodeAt(0) - 0xff10));
}

function chineseChapterNumber(value) {
  const text = normalizeDigitText(value).trim();
  if (/^\d+$/.test(text)) return Number(text);
  const map = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (!/[十百千]/.test(text)) {
    return Array.from(text).reduce((total, char) => total * 10 + (map[char] ?? 0), 0);
  }
  let total = 0;
  let current = 0;
  for (const char of text) {
    if (char === "千") {
      total += (current || 1) * 1000;
      current = 0;
    } else if (char === "百") {
      total += (current || 1) * 100;
      current = 0;
    } else if (char === "十") {
      total += (current || 1) * 10;
      current = 0;
    } else if (Object.prototype.hasOwnProperty.call(map, char)) {
      current = map[char];
    }
  }
  return total + current;
}

function chapterNo(file) {
  const base = path.basename(file, ".txt");
  const numeric = normalizeDigitText(base).match(/^(\d+)(?:[-_、.\s]|第|章|$)/);
  if (numeric) return Number(numeric[1]);
  const titled = base.match(/^第\s*([0-9０-９零〇一二两三四五六七八九十百千万]+)\s*章/);
  return titled ? chineseChapterNumber(titled[1]) : 0;
}

function parseChapterHeading(firstLine, fallbackNo, file) {
  const fallbackTitle = path.basename(file, ".txt").replace(/^\d+[-_、.\s]*/, "").trim();
  const raw = (firstLine || fallbackTitle).trim();
  const match = raw.match(/^第\s*([0-9零一二三四五六七八九十百千万]+)\s*章\s*[:：、.\-\s]*(.+)$/);
  if (!match) {
    return {
      chapterNoText: String(fallbackNo || ""),
      chapterTitle: raw,
      fullTitle: raw,
      headingRemoved: Boolean(firstLine),
    };
  }
  return {
    chapterNoText: String(fallbackNo || match[1]),
    chapterTitle: match[2].trim(),
    fullTitle: raw,
    headingRemoved: true,
  };
}

function visibleCharCount(text) {
  return Array.from(text.replace(/\s/g, "")).length;
}

function platformCharCount(text) {
  return (text.match(/\p{Script=Han}/gu) || []).length;
}

function listTxtFiles(dir) {
  const files = [];
  const walk = (current) => {
    for (const item of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, item.name);
      if (item.isDirectory()) walk(full);
      else if (item.name.endsWith(".txt")) files.push(full);
    }
  };
  walk(dir);
  return files;
}

function readChapters(chaptersDir, start, end) {
  return listTxtFiles(chaptersDir)
    .map((file) => {
      const no = chapterNo(file);
      const raw = fs.readFileSync(file, "utf8").trim();
      const [firstLine, ...rest] = raw.split(/\r?\n/);
      const heading = parseChapterHeading(firstLine, no, file);
      const body = rest.join("\n").trim();
      return {
        no,
        file,
        title: heading.chapterTitle,
        fullTitle: heading.fullTitle,
        chapterNoText: heading.chapterNoText,
        body,
        raw,
        chars: visibleCharCount(body),
        platformChars: platformCharCount(body),
      };
    })
    .filter((chapter) => chapter.no >= start && chapter.no <= end)
    .sort((a, b) => a.no - b.no);
}

function similarity(a, b) {
  const seg = (text) => {
    const clean = text.replace(/\s/g, "");
    const set = new Set();
    for (let i = 0; i < clean.length - 8; i += 5) set.add(clean.slice(i, i + 9));
    return set;
  };
  const x = seg(a);
  const y = seg(b);
  if (!x.size || !y.size) return 0;
  let hit = 0;
  for (const item of x) if (y.has(item)) hit++;
  return hit / Math.min(x.size, y.size);
}

function repeatedParagraphRatio(body) {
  const paragraphs = body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (paragraphs.length < 4) return 0;
  const normalized = paragraphs.map((p) => p.replace(/\s/g, ""));
  const seen = new Set();
  let repeated = 0;
  for (const p of normalized) {
    const key = p.slice(0, 80);
    if (seen.has(key)) repeated++;
    seen.add(key);
  }
  return repeated / paragraphs.length;
}

function validateChapters(chapters, args) {
  const issues = [];
  const byNo = new Map();
  for (const chapter of chapters) {
    if (!chapter.no) issues.push({ level: "error", no: "?", message: `文件名缺少三位章节号：${chapter.file}` });
    if (byNo.has(chapter.no)) issues.push({ level: "error", no: chapter.no, message: `章节号重复：${chapter.file}` });
    byNo.set(chapter.no, chapter);
    if (!chapter.title) issues.push({ level: "error", no: chapter.no, message: "标题为空" });
    if (!chapter.body) issues.push({ level: "error", no: chapter.no, message: "正文为空" });
    if (chapter.platformChars < args.minChars) {
      issues.push({ level: "error", no: chapter.no, message: `有效正文不足 ${args.minChars} 字，当前有效汉字 ${chapter.platformChars} 字；含标点非空白字符 ${chapter.chars} 字` });
    }
    if (repeatedParagraphRatio(chapter.body) > 0.2) issues.push({ level: "warn", no: chapter.no, message: "本章疑似存在重复段落" });
  }

  for (let n = args.start; n <= Math.min(args.end, chapters.at(-1)?.no || 0); n++) {
    if (!byNo.has(n)) issues.push({ level: "error", no: n, message: "章节号缺失" });
  }

  for (let i = 1; i < chapters.length; i++) {
    const score = similarity(chapters[i - 1].body, chapters[i].body);
    if (score > 0.55) {
      issues.push({ level: "warn", no: chapters[i].no, message: `与上一章相似度偏高：${Math.round(score * 100)}%` });
    }
  }

  return issues;
}

function makeRunId(args) {
  const chapterRoot = path.resolve(args.chapters);
  return safeName(`${args.book || "novel"}_${chapterRoot}_${args.start}_${Number.isFinite(args.end) ? args.end : "all"}_${args.mode}`);
}

function loadState(runId, args) {
  ensureDir(RUNS_DIR);
  const statePath = path.join(RUNS_DIR, `${runId}.json`);
  if (args.reset && fs.existsSync(statePath)) fs.unlinkSync(statePath);
  if (!args.resume || !fs.existsSync(statePath)) {
    return {
      runId,
      mode: args.mode,
      chapters: path.resolve(args.chapters),
      start: args.start,
      end: Number.isFinite(args.end) ? args.end : null,
      completed: [],
      failed: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  return JSON.parse(fs.readFileSync(statePath, "utf8"));
}

function saveState(runId, state) {
  ensureDir(RUNS_DIR);
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(path.join(RUNS_DIR, `${runId}.json`), JSON.stringify(state, null, 2), "utf8");
}

function logLine(runId, message) {
  ensureDir(RUNS_DIR);
  fs.appendFileSync(path.join(RUNS_DIR, `${runId}.log`), `[${new Date().toISOString()}] ${message}\n`, "utf8");
}

async function saveFailure(page, runId, chapter, reason) {
  const dir = path.join(RUNS_DIR, runId);
  ensureDir(dir);
  const prefix = `${String(chapter?.no || "unknown").padStart(3, "0")}-${Date.now()}`;
  const screenshotPath = path.join(dir, `${prefix}.png`);
  const htmlPath = path.join(dir, `${prefix}.html`);
  try {
    await page.screenshot({ path: screenshotPath, fullPage: true });
  } catch {}
  try {
    fs.writeFileSync(htmlPath, await page.content(), "utf8");
  } catch {}
  logLine(runId, `失败截图：${screenshotPath}；原因：${reason}`);
}

async function inspectPage(page, runId) {
  const dir = path.join(RUNS_DIR, runId);
  ensureDir(dir);
  const screenshotPath = path.join(dir, `inspect-${Date.now()}.png`);
  const htmlPath = path.join(dir, `inspect-${Date.now()}.html`);
  const jsonPath = path.join(dir, `inspect-${Date.now()}.json`);

  const data = await page.evaluate(() => {
    const rectOf = (el) => {
      const rect = el.getBoundingClientRect();
      return {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        visible: rect.width > 0 && rect.height > 0,
      };
    };
    return {
      url: location.href,
      title: document.title,
      inputs: Array.from(document.querySelectorAll("input")).map((input, index) => ({
        index,
        className: input.className,
        id: input.id,
        name: input.name,
        type: input.type,
        placeholder: input.getAttribute("placeholder"),
        valueProperty: input.value,
        valueAttribute: input.getAttribute("value"),
        outerHTML: input.outerHTML.slice(0, 500),
        rect: rectOf(input),
      })),
      editors: Array.from(document.querySelectorAll("[contenteditable='true'], .ProseMirror")).map((el, index) => ({
        index,
        className: el.className,
        tagName: el.tagName,
        textStart: (el.textContent || "").trim().slice(0, 200),
        outerHTML: el.outerHTML.slice(0, 500),
        rect: rectOf(el),
      })),
    };
  });

  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
  fs.writeFileSync(htmlPath, await page.content(), "utf8");
  fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2), "utf8");
  console.log(`页面诊断已保存：${jsonPath}`);
  console.log(`截图已保存：${screenshotPath}`);
  console.log(`脚本看到 ${data.inputs.length} 个 input，${data.editors.length} 个编辑器。`);
  data.inputs.slice(0, 8).forEach((input) => {
    console.log(`#${input.index} class="${input.className}" placeholder="${input.placeholder}" value="${input.valueProperty}" rect=${JSON.stringify(input.rect)}`);
  });
}

async function pageScore(page) {
  return page.evaluate(() => {
    const inputCount = document.querySelectorAll("input").length;
    const editorCount = document.querySelectorAll("[contenteditable='true'], .ProseMirror").length;
    const serialEditor = document.querySelectorAll(".serial-editor, .serial-editor-title-left, .serial-editor-title-right").length;
    return {
      url: location.href,
      title: document.title,
      inputCount,
      editorCount,
      serialEditor,
      score: inputCount + editorCount * 10 + serialEditor * 20,
    };
  }).catch(() => ({
    url: page.url(),
    title: "",
    inputCount: 0,
    editorCount: 0,
    serialEditor: 0,
    score: 0,
  }));
}

async function selectEditorPage(browser, preferredPage) {
  let pages = browser.pages();
  if (!pages.includes(preferredPage)) pages = [preferredPage, ...pages];
  const scored = [];
  for (const page of pages) {
    scored.push({ page, ...(await pageScore(page)) });
  }
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0]?.page || preferredPage;
  console.log("当前浏览器标签页诊断：");
  scored.forEach((item, index) => {
    console.log(`#${index + 1} score=${item.score} inputs=${item.inputCount} editors=${item.editorCount} serial=${item.serialEditor} url=${item.url}`);
  });
  return best;
}

async function selectChapterManagePage(browser, preferredPage) {
  const pages = browser.pages();
  const scored = [];
  for (const page of pages) {
    const data = await page.evaluate(() => {
      const text = document.body?.textContent || "";
      return {
        url: location.href,
        title: document.title,
        hasChapterManage: text.includes("章节管理"),
        hasDraftBox: text.includes("草稿箱"),
        hasNewChapter: text.includes("新建章节"),
        score: (text.includes("章节管理") ? 30 : 0)
          + (text.includes("草稿箱") ? 30 : 0)
          + (text.includes("新建章节") ? 20 : 0)
          + (location.href.includes("chapter-manage") ? 20 : 0),
      };
    }).catch(() => ({ url: page.url(), title: "", score: 0, hasChapterManage: false, hasDraftBox: false, hasNewChapter: false }));
    scored.push({ page, ...data });
  }
  scored.sort((a, b) => b.score - a.score);
  console.log("章节管理页诊断：");
  scored.forEach((item, index) => {
    console.log(`#${index + 1} score=${item.score} manage=${item.hasChapterManage} drafts=${item.hasDraftBox} new=${item.hasNewChapter} url=${item.url}`);
  });
  return scored[0]?.score > 0 ? scored[0].page : preferredPage;
}

async function ensureEditorPageForDraft(browser, preferredPage, book = "") {
  let best = await selectEditorPage(browser, preferredPage);
  const score = await pageScore(best);
  if (score.editorCount > 0 && score.serialEditor > 0) return best;

  console.log("当前还不是章节写入页，尝试点击“新建章节”进入写入页。");
  const clicked = await clickNewChapterButton(best, { book, timeout: 3000 });
  if (clicked) {
    await wait(1800);
    best = await selectEditorPage(browser, best);
    const nextScore = await pageScore(best);
    if (nextScore.editorCount > 0 || nextScore.serialEditor > 0) return best;
  }

  for (const page of browser.pages()) {
    if (page === best) continue;
    const clickedOther = await clickNewChapterButton(page, { book, timeout: 1500 });
    if (clickedOther) {
      await wait(1800);
      const candidate = await selectEditorPage(browser, page);
      const candidateScore = await pageScore(candidate);
      if (candidateScore.editorCount > 0 || candidateScore.serialEditor > 0) return candidate;
    }
  }

  return best;
}

async function isEditorPage(page) {
  const score = await pageScore(page);
  return score.editorCount > 0 && score.serialEditor > 0;
}

async function selectFreshEditorPage(browser, preferredPage, excludedPage, timeout = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const pages = browser.pages().filter((page) => page !== excludedPage && !page.isClosed());
    const ordered = pages.includes(preferredPage) ? [preferredPage, ...pages.filter((page) => page !== preferredPage)] : pages;
    let best = null;
    let bestScore = -1;
    for (const page of ordered) {
      const score = await pageScore(page);
      const value = score.editorCount * 50 + score.serialEditor * 50;
      if (value > bestScore) {
        best = page;
        bestScore = value;
      }
      if (score.editorCount > 0 && score.serialEditor > 0) return page;
    }
    if (best && bestScore > 0) return best;
    await wait(500);
  }
  return preferredPage;
}

async function openFreshChapterPage(browser, currentPage, newChapterUrl, book = "", managerUrl = "") {
  if (newChapterUrl) {
    const nextPage = await browser.newPage();
    await nextPage.goto(newChapterUrl, { waitUntil: "domcontentloaded" });
    await wait(1800);
    if (await isEditorPage(nextPage)) return nextPage;

    console.log("--new-url 打开后不是章节编辑页，尝试在该页面点击“新建章节”。");
    const clicked = await clickNewChapterButton(nextPage, { book, timeout: 3500 });
    if (clicked) {
      await wait(2000);
      const editor = await selectFreshEditorPage(browser, nextPage, currentPage);
      if (await isEditorPage(editor)) return editor;
    }

    console.log("--new-url 未能进入编辑页，将继续从其他后台页面寻找“新建章节”。");
  }

  const managerCandidates = browser.pages().filter((page) => page !== currentPage && !page.isClosed());
  for (const page of managerCandidates) {
    const clicked = await clickNewChapterButton(page, { book, timeout: 1800 });
    if (clicked) {
      await wait(2000);
      const editor = await selectFreshEditorPage(browser, page, currentPage);
      if (await isEditorPage(editor)) return editor;
    }
  }

  const nextPage = await browser.newPage();
  if (managerUrl) {
    await nextPage.goto(managerUrl, { waitUntil: "domcontentloaded" });
    await wait(1800);
    const clicked = await clickNewChapterButton(nextPage, { book, timeout: 3500 });
    if (clicked) {
      await wait(2000);
      const editor = await selectFreshEditorPage(browser, nextPage, currentPage);
      if (await isEditorPage(editor)) return editor;
    }
    console.log("已回到作品后台 URL，但未能自动进入新建章节页。请检查“新建章节”入口。");
    return nextPage;
  }
  await nextPage.goto("https://fanqienovel.com/writer/zone", { waitUntil: "domcontentloaded" });
  console.log("没有提供作品后台 URL，也没有在其他标签页找到“新建章节”按钮。请手动打开新的章节编辑页。");
  return nextPage;
}

async function clickByTexts(page, texts, options = {}) {
  for (const text of texts) {
    const locator = page.getByRole("button", { name: new RegExp(text) }).first();
    if (await locator.count().catch(() => 0)) {
      try {
        await locator.click({ timeout: options.timeout || 2500 });
        return true;
      } catch {}
    }
  }

  for (const text of texts) {
    const locator = page.locator(`text=${text}`).first();
    if (await locator.count().catch(() => 0)) {
      try {
        await locator.click({ timeout: options.timeout || 2500 });
        return true;
      } catch {}
    }
  }
  return false;
}

async function clickNewChapterButton(page, options = {}) {
  const book = String(options.book || "").trim();
  const timeout = options.timeout || 2500;
  const result = await page.evaluate(({ book }) => {
    const labels = ["新建章节", "添加章节", "写新章节", "创建章节", "新建"];
    const normalize = (value) => String(value || "").replace(/\s+/g, "");
    const bookText = normalize(book);
    const isVisible = (node) => {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const textOf = (node) => normalize(node.textContent || node.getAttribute?.("aria-label") || node.getAttribute?.("title") || "");
    const clickableOf = (node) => node.closest("button,a,[role='button'],.arco-btn,.semi-button");
    const candidates = [];
    for (const node of Array.from(document.querySelectorAll("button,a,[role='button'],.arco-btn,.semi-button,span"))) {
      const text = textOf(node);
      if (!labels.some((label) => text === label || text.includes(label))) continue;
      const clickable = clickableOf(node);
      if (!clickable || !isVisible(clickable)) continue;
      const rect = clickable.getBoundingClientRect();
      const rectKey = [
        Math.round(rect.left / 4) * 4,
        Math.round(rect.top / 4) * 4,
        Math.round(rect.width / 4) * 4,
        Math.round(rect.height / 4) * 4,
      ].join(",");
      let ancestor = clickable;
      let score = 0;
      let scopeText = "";
      for (let depth = 0; ancestor && depth < 8; depth++) {
        const ancestorText = normalize(ancestor.textContent || "");
        if (bookText && ancestorText.includes(bookText)) score += 100 - depth * 5;
        if (ancestorText.includes("章节管理")) score += 10;
        if (ancestorText.includes("草稿箱")) score += 5;
        if (!scopeText && ancestorText.length <= 2000) scopeText = ancestorText.slice(0, 200);
        ancestor = ancestor.parentElement;
      }
      candidates.push({ clickable, text, score, scopeText, rectKey });
    }
    const unique = [];
    const seen = new Set();
    for (const item of candidates) {
      const key = item.rectKey || item.clickable;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(item);
    }
    if (!unique.length) return { clicked: false, reason: "not-found", count: 0 };
    unique.sort((a, b) => b.score - a.score);
    const pageText = normalize(document.body?.innerText || "");
    const pageMatchesBook = bookText && pageText.includes(bookText);
    const pageLooksManager = /章节管理|草稿箱|章节名称|审核状态/.test(pageText);
    if (unique.length > 1 && bookText && unique[0].score <= 0 && !(pageMatchesBook && pageLooksManager && unique.length <= 5)) {
      return { clicked: false, reason: "ambiguous", count: unique.length };
    }
    if (unique.length > 1 && !bookText) {
      return { clicked: false, reason: "ambiguous", count: unique.length };
    }
    unique[0].clickable.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
    return { clicked: true, reason: "clicked", count: unique.length, score: unique[0].score };
  }, { book }).catch((error) => ({ clicked: false, reason: error.message || String(error), count: 0 }));

  if (result.clicked) {
    await wait(Math.min(timeout, 1200));
    return true;
  }
  if (result.reason === "ambiguous") {
    console.log(`检测到 ${result.count} 个“新建章节”候选入口，无法确认属于《${book || "当前作品"}》，已停止自动点击以避免点错作品。请先点击“测试后台 URL”，确认书名匹配后再运行。`);
  }
  return false;
}

async function dismissTutorialOverlays(page) {
  const clickedLabels = [];
  if (await clickContinueEditingPrompt(page)) clickedLabels.push("continue-editing");
  for (let i = 0; i < 8; i++) {
    const clicked = await clickByTexts(page, ["跳过", "我知道了", "知道了", "完成", "关闭"], { timeout: 800 });
    if (!clicked) break;
    clickedLabels.push("clicked");
    await wait(500);
  }
  if (await clickContinueEditingPrompt(page)) clickedLabels.push("continue-editing");

  await page.keyboard.press("Escape").catch(() => {});
  await page.evaluate(() => {
    const selectors = [
      ".arco-tour",
      ".arco-tour-mask",
      ".arco-modal-mask",
      ".driver-popover",
      ".introjs-overlay",
      ".introjs-tooltip",
    ];
    for (const selector of selectors) {
      document.querySelectorAll(selector).forEach((node) => {
        const el = node;
        if (el && el.style) el.style.display = "none";
      });
    }
  }).catch(() => {});
  return clickedLabels.length;
}

async function clickContinueEditingPrompt(page) {
  const modal = page.locator(".arco-modal").filter({ hasText: /刚刚更新的章节|继续编辑|是否继续编辑/ }).last();
  try {
    if (!(await modal.count()) || !(await modal.isVisible())) return false;
    await wait(1000);
    const button = modal.locator("button").filter({ hasText: /^继续编辑$/ }).last();
    if (await button.count()) {
      console.log("检测到“是否继续编辑”提示，已选择继续编辑。");
      await button.click({ timeout: 3000 });
      await wait(1200);
      return true;
    }
  } catch {}
  return false;
}

async function cancelPublishPromptIfDraft(page) {
  const modal = page.locator(".arco-modal").filter({ hasText: /发布提示|检测到你还存错别字未修改|是否确定提交/ }).last();
  try {
    if (!(await modal.count()) || !(await modal.isVisible())) return false;
    const cancel = modal.locator("button").filter({ hasText: /^取消$/ }).last();
    if (await cancel.count()) {
      console.log("草稿模式检测到发布提示，已取消并返回编辑页。");
      await cancel.click({ timeout: 3000 });
      await wait(1200);
      return true;
    }
  } catch {}
  return false;
}

async function fillFirstInput(page, includePattern, value, excludePattern) {
  const inputs = page.locator("input");
  const count = await inputs.count().catch(() => 0);
  for (let i = 0; i < count; i++) {
    const locator = inputs.nth(i);
    try {
      const meta = [
        await locator.getAttribute("placeholder").catch(() => ""),
        await locator.getAttribute("aria-label").catch(() => ""),
        await locator.getAttribute("name").catch(() => ""),
        await locator.getAttribute("id").catch(() => ""),
      ].join(" ");
      if (excludePattern && excludePattern.test(meta)) continue;
      if (includePattern && !includePattern.test(meta)) continue;
      if (await locator.isVisible().catch(() => false)) {
        await locator.fill(value, { timeout: 2500 });
        return true;
      }
    } catch {}
  }
  return false;
}

async function setInputValueBySelectors(page, selectors, value, timeout = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    for (const frame of page.frames()) {
      const ok = await frame.evaluate(({ selectors, value }) => {
        const setNativeValue = (input, nextValue) => {
          const stringValue = String(nextValue);
          const proto = window.HTMLInputElement.prototype;
          const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
          input.focus();
          if (descriptor && descriptor.set) descriptor.set.call(input, stringValue);
          else input.value = stringValue;

          // Make DevTools show value="x" instead of a bare value attribute.
          input.setAttribute("value", stringValue);

          input.dispatchEvent(new InputEvent("input", {
            bubbles: true,
            composed: true,
            data: stringValue,
            inputType: "insertText",
          }));
          input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
          input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, composed: true, key: stringValue.slice(-1) || "1" }));
          input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, composed: true, key: stringValue.slice(-1) || "1" }));
          input.blur();
        };

        for (const selector of selectors) {
          const input = document.querySelector(selector);
          if (input && input instanceof HTMLInputElement) {
            setNativeValue(input, value);
            return true;
          }
        }
        return false;
      }, { selectors, value }).catch(() => false);
      if (ok) return true;
    }
    await wait(250);
  }
  return false;
}

async function fillChapterNumber(page, chapterNoText) {
  if (!chapterNoText) return false;
  const direct = page.locator("input.serial-input.byte-input.byte-input-size-default").nth(0);
  try {
    if (await direct.count()) {
      await direct.fill(String(chapterNoText), { timeout: 3000 });
      await direct.evaluate((input, value) => {
        input.value = String(value);
        input.setAttribute("value", String(value));
        input.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, data: String(value), inputType: "insertText" }));
        input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      }, chapterNoText);
      return true;
    }
  } catch {}

  const ok = await setInputValueBySelectors(page, [
    ".serial-editor-title-left input.serial-input",
    ".serial-editor-title-left input.byte-input",
    ".serial-editor-title-left input",
    ".serial-editor-title-inner .serial-editor-title-left input",
    "span.left-input input.serial-input",
    "input.serial-input.byte-input.byte-input-size-default",
  ], chapterNoText);
  if (ok) return true;
  return fillFirstInput(page, /章节序号|章节号|章序|第几章|序号|请输入章节号|请输入序号|chapter.*no|chapter.*number/i, chapterNoText);
}

async function fillTitle(page, title) {
  const direct = page.locator("input.serial-input.serial-editor-input-hint-area.byte-input.byte-input-size-default").nth(0);
  try {
    if (await direct.count()) {
      await direct.fill(String(title), { timeout: 3000 });
      await direct.evaluate((input, value) => {
        input.value = String(value);
        input.setAttribute("value", String(value));
        input.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, data: String(value), inputType: "insertText" }));
        input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      }, title);
      return true;
    }
  } catch {}

  const ok = await setInputValueBySelectors(page, [
    ".serial-editor-title-right input.serial-input",
    ".serial-editor-title-right input.byte-input",
    ".serial-editor-title-right input",
    ".serial-editor-input-hint input.serial-input",
    ".serial-editor-input-hint input.byte-input",
    ".serial-editor-input-hint input",
    ".serial-editor-title-right input[placeholder*='标题']",
    ".serial-editor-input-hint input[placeholder*='标题']",
    "input[placeholder='请输入标题']",
    "input[placeholder*='请输入标题']",
  ], title);
  if (ok) return true;
  return fillFirstInput(
    page,
    /章节名|章节标题|标题|请输入标题|请输入章节|chapter.*title|title/i,
    title,
    /章节序号|章节号|章序|第几章|序号|请输入章节号|请输入序号|chapter.*no|chapter.*number/i
  );
}

async function removeFirstHeadingFromEditor(page) {
  return page.evaluate(() => {
    const editor = document.querySelector(".ProseMirror[contenteditable='true'], [contenteditable='true'].ProseMirror");
    if (!editor) return false;
    const first = Array.from(editor.children).find((node) => {
      const text = (node.textContent || "").trim();
      return text.length > 0;
    });
    if (!first) return false;
    const text = (first.textContent || "").trim();
    if (!/^第\s*[0-9零一二三四五六七八九十百千万]+\s*章\s+.+/.test(text)) return false;
    first.remove();
    editor.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "deleteContentBackward",
      data: null,
    }));
    editor.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }).catch(() => false);
}

async function fillBody(page, chapter) {
  const body = chapter.body;
  const focused = await page.evaluate(() => {
    const editor = document.querySelector(".ProseMirror[contenteditable='true'], [contenteditable='true'].ProseMirror");
    if (!editor) return false;
    editor.scrollIntoView({ block: "center" });
    editor.focus();
    return true;
  }).catch(() => false);
  if (focused) {
    await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
    await page.keyboard.press("Backspace");
    await page.keyboard.insertText(body);
    await removeFirstHeadingFromEditor(page);
    return true;
  }

  const candidates = [
    page.locator(".ProseMirror[contenteditable='true']").first(),
    page.locator("[contenteditable='true']").last(),
    page.locator(".ql-editor").first(),
    page.locator("textarea").last(),
  ];
  for (const locator of candidates) {
    try {
      if (await locator.count()) {
        if (await locator.isVisible().catch(() => false)) {
          try {
            await locator.fill(body, { timeout: 3500 });
          } catch {
            await locator.click({ timeout: 2500 });
            await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
            await page.keyboard.press("Backspace");
            await page.keyboard.insertText(body);
          }
          await removeFirstHeadingFromEditor(page);
          return true;
        }
      }
    } catch {}
  }
  return false;
}

async function removeBodyHeadingIfNeeded(page) {
  return removeFirstHeadingFromEditor(page);
}

async function pasteFullTextThenDeleteHeading(page, chapter) {
  const fullText = `${chapter.fullTitle}\n\n${chapter.body}`.trim();
  const editor = page.locator(".ProseMirror[contenteditable='true']").first();
  try {
    if (await editor.count() && await editor.isVisible()) {
      await editor.click({ timeout: 2500 });
      await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
      await page.keyboard.press("Backspace");
      await page.keyboard.insertText(fullText);
      await removeFirstHeadingFromEditor(page);
      return true;
    }
  } catch {}
  return false;
}

async function fillBodyWithFallback(page, chapter) {
  if (await fillBody(page, chapter)) return true;
  return pasteFullTextThenDeleteHeading(page, chapter);
}

async function verifyEditorHeadingRemoved(page) {
  return page.evaluate(() => {
    const editor = document.querySelector(".ProseMirror[contenteditable='true'], [contenteditable='true'].ProseMirror");
    if (!editor) return true;
    const first = Array.from(editor.children).find((node) => (node.textContent || "").trim());
    if (!first) return true;
    const text = (first.textContent || "").trim();
    return !/^第\s*[0-9零一二三四五六七八九十百千万]+\s*章\s+.+/.test(text);
  }).catch(() => true);
}

async function ensureBodyHeadingRemoved(page) {
  await removeBodyHeadingIfNeeded(page);
  if (await verifyEditorHeadingRemoved(page)) return true;
  const editor = page.locator(".ProseMirror[contenteditable='true']").first();
  try {
    await editor.click({ timeout: 2000 });
    await page.keyboard.press(process.platform === "darwin" ? "Meta+Home" : "Control+Home");
    await page.keyboard.down("Shift");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.up("Shift");
    await page.keyboard.press("Backspace");
    return verifyEditorHeadingRemoved(page);
  } catch {
    return false;
  }
}

async function fillBodyAndCleanHeading(page, chapter) {
  const ok = await fillBodyWithFallback(page, chapter);
  if (!ok) return false;
  return ensureBodyHeadingRemoved(page);
}

async function verifyDraftContentReady(page, chapter) {
  return page.evaluate(({ no, title, minBodyLength }) => {
    const textOf = (node) => (node?.textContent || node?.value || "").trim();
    const pageText = document.body?.innerText || "";
    const titleInput = document.querySelector("input.serial-input.serial-editor-input-hint-area")
      || document.querySelector(".serial-editor-title-right input")
      || document.querySelector("input[placeholder*='标题']");
    const numberInput = document.querySelector(".serial-editor-title-left input")
      || document.querySelector("span.left-input input")
      || document.querySelector("input.serial-input.byte-input");
    const editor = document.querySelector(".ProseMirror[contenteditable='true']");
    const actualTitle = textOf(titleInput);
    const actualNumber = textOf(numberInput);
    const bodyText = textOf(editor);
    return {
      ok: (!actualTitle || actualTitle.includes(title) || title.includes(actualTitle))
        && (!actualNumber || actualNumber === String(no))
        && bodyText.length >= minBodyLength,
      actualTitle,
      actualNumber,
      bodyLength: bodyText.length,
      hasSavedText: /已保存|保存到云端|已保存到云端/.test(pageText),
    };
  }, {
    no: chapter.no,
    title: chapter.title,
    minBodyLength: Math.min(200, Math.max(20, Math.floor(chapter.body.length * 0.2))),
  }).catch(() => ({ ok: false, actualTitle: "", actualNumber: "", bodyLength: 0, hasSavedText: false }));
}

async function waitForDraftSaved(page, timeout = 15000) {
  await wait(3000);
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const block = await detectPublishBlock(page);
    if (block) return { ok: false, reason: formatPublishBlockReason(block) };
    const saved = await page.evaluate(() => /已保存|保存到云端|已保存到云端/.test(document.body?.innerText || "")).catch(() => false);
    if (saved) {
      await wait(2000);
      return { ok: true };
    }
    await wait(500);
  }
  return { ok: false, reason: "保存草稿后未检测到已保存状态" };
}

async function waitForPublishConfirmed(page, timeout = 18000) {
  await wait(1500);
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const block = await detectPublishBlock(page);
    if (block) return { ok: false, reason: formatPublishBlockReason(block) };
    const state = await page.evaluate(() => {
      const text = document.body?.innerText || "";
      const successPattern = /(发布成功|提交成功|已提交|已发布|审核中|等待审核|发布完成|章节已发布)/;
      const messageSuccess = Array.from(document.querySelectorAll(".arco-message, .arco-message-wrapper, .arco-notification, .arco-notification-wrapper, .semi-toast, .semi-toast-wrapper, [role='alert'], [class*='message'], [class*='toast'], [class*='notification']"))
        .some((node) => successPattern.test(node.textContent || ""));
      const editorVisible = Array.from(document.querySelectorAll(".ProseMirror[contenteditable='true'], [contenteditable='true'].ProseMirror"))
        .some((node) => {
          const rect = node.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        });
      const success = messageSuccess || (!editorVisible && successPattern.test(text));
      const pendingDialogs = Array.from(document.querySelectorAll(".arco-modal, [role='dialog'], .semi-modal"))
        .map((node) => {
          const value = node.textContent || "";
          const rect = node.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && /(确认发布|发布设置|是否使用AI|提交|发布|错误|失败|上限|限制|提示)/.test(value)
            ? value.replace(/\s+/g, "").slice(0, 180)
            : "";
        })
        .filter(Boolean);
      return { success, pendingDialog: pendingDialogs.length > 0, dialogText: pendingDialogs[0] || "" };
    }).catch(() => ({ success: false, pendingDialog: false }));
    if (state.success) return { ok: true };
    if (state.pendingDialog) {
      await wait(1000);
      const block = await detectPublishBlock(page);
      if (block) return { ok: false, reason: formatPublishBlockReason(block) };
    }
    await wait(700);
  }
  const dialogText = await page.evaluate(() => Array.from(document.querySelectorAll(".arco-modal, [role='dialog'], .semi-modal"))
    .map((node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 ? (node.textContent || "").replace(/\s+/g, "").slice(0, 180) : "";
    })
    .find(Boolean) || "").catch(() => "");
  return { ok: false, reason: dialogText ? `发布后仍有提示框未处理：${dialogText}` : "发布后未检测到成功状态，已停止，避免日志虚假推进" };
}

async function submitChapter(page, mode) {
  if (mode === "publish") {
    const primary = await page.evaluate(() => {
      const isVisible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };
      const buttons = Array.from(document.querySelectorAll("button, .arco-btn, div, span"))
        .filter((node) => isVisible(node));
      const target = buttons.find((node) => {
        const text = (node.textContent || "").trim();
        const cls = String(node.className || "");
        return /下一步|发布|发表|提交发布|立即发布/.test(text) && (cls.includes("primary") || cls.includes("arco-btn") || node.tagName === "BUTTON");
      });
      if (!target) return false;
      target.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
      return true;
    }).catch(() => false);
    if (primary) {
      await wait(1500);
      return true;
    }
    return clickByTexts(page, ["下一步", "发布", "发表", "提交发布", "立即发布"], { timeout: 3500 });
  }
  await cancelPublishPromptIfDraft(page);
  return clickByTexts(page, ["保存草稿", "存草稿", "暂存"], { timeout: 3500 });
}

async function findDraftRowForChapter(page, chapter) {
  const escapedTitle = chapter.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    `第\\s*${chapter.no}\\s*章`,
    `第\\s*${chapter.chapterNoText}\\s*章`,
    escapedTitle,
  ];

  for (const pattern of patterns) {
    const textLocator = page.locator(`text=/${pattern}/`).first();
    try {
      if (await textLocator.count()) {
        const row = textLocator.locator("xpath=ancestor::*[self::tr or contains(@class,'item') or contains(@class,'card') or contains(@class,'chapter') or contains(@class,'draft') or contains(@class,'list')][1]");
        if (await row.count()) return row.first();
        return textLocator.locator("xpath=ancestor::div[1]").first();
      }
    } catch {}
  }
  return null;
}

async function clickPublishInDraftRow(page, row) {
  if (row) {
    const editIconSelectors = [
      ".auto-editor-draft-edit",
      ".icon-edit.tomato-edit",
      "span[class*='draft-edit']",
      "span[class*='icon-edit']",
    ];
    for (const selector of editIconSelectors) {
      try {
        const icon = row.locator(selector).first();
        if (await icon.count()) {
          console.log("找到草稿行编辑图标，进入草稿编辑页。");
          await icon.click({ timeout: 2500 });
          await wait(1800);
          return "opened-editor";
        }
      } catch {}
    }
  }

  const labels = ["发布", "发表", "提交发布", "立即发布"];
  if (row) {
    for (const label of labels) {
      const button = row.getByRole("button", { name: new RegExp(label) }).first();
      try {
        if (await button.count()) {
          await button.click({ timeout: 2500 });
          return true;
        }
      } catch {}
      const textButton = row.locator(`text=${label}`).first();
      try {
        if (await textButton.count()) {
          await textButton.click({ timeout: 2500 });
          return true;
        }
      } catch {}
    }
  }
  return clickByTexts(page, labels, { timeout: 2500 });
}

async function clickDialogButton(page, labels, timeout = 1200) {
  const dialog = page.locator(".arco-modal, .arco-modal-content, [role='dialog']").last();
  for (const label of labels) {
    try {
      const buttons = dialog.getByRole("button", { name: new RegExp(`^\\s*${label}\\s*$`) });
      const count = await buttons.count();
      if (count) {
        await wait(2000);
        await buttons.nth(count - 1).click({ timeout });
        await wait(1200);
        return true;
      }
    } catch {}
    try {
      const textButton = dialog.locator(`button:has-text("${label}")`).last();
      if (await textButton.count()) {
        await wait(2000);
        await textButton.click({ timeout });
        await wait(1200);
        return true;
      }
    } catch {}
  }
  return false;
}

async function clickTypoSubmit(page) {
  const modalLocator = page.locator(".arco-modal").filter({ hasText: /检测到你还存错别字未修改|是否确定提交/ }).last();
  try {
    if (await modalLocator.count()) {
      await wait(2000);
      const result = await page.evaluate(() => {
        const modals = Array.from(document.querySelectorAll(".arco-modal"))
          .filter((modal) => /检测到你还存错别字未修改|是否确定提交/.test(modal.textContent || ""));
        const modal = modals.at(-1);
        if (!modal) return { ok: false, reason: "no modal" };

        const buttons = Array.from(modal.querySelectorAll(".arco-modal-footer button"));
        const summary = buttons.map((button, index) => ({
          index,
          text: (button.textContent || "").trim(),
          className: String(button.className || ""),
          disabled: Boolean(button.disabled) || button.getAttribute("aria-disabled") === "true",
        }));
        const submit = buttons.find((button) => (button.textContent || "").trim() === "提交");
        if (!submit) return { ok: false, reason: "no submit", summary };
        if (submit.disabled || submit.getAttribute("aria-disabled") === "true") return { ok: false, reason: "submit disabled", summary };

        submit.focus();
        submit.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, composed: true }));
        submit.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true, composed: true }));
        submit.click();
        return { ok: true, summary };
      }).catch((error) => ({ ok: false, reason: error.message || String(error), summary: [] }));

      console.log(`错别字弹窗按钮：${JSON.stringify(result.summary || [])}`);
      if (result.ok) {
        console.log("已触发错别字提示弹窗中的“提交”按钮。");
        await wait(3000);
        return true;
      }
      console.log(`未能触发“提交”按钮：${result.reason || "unknown"}，暂停等待手动处理。`);
      return false;
    }
  } catch {}
  return false;
}

async function clickBasicCheck(page) {
  const modal = page.locator(".arco-modal").filter({ hasText: /请选择内容检测方式|基础检测|全面检测/ }).last();
  try {
    if (await modal.count() && await modal.isVisible()) {
      await wait(2000);
      const button = modal.locator("button").filter({ hasText: /^仅基础检测$/ }).last();
      if (await button.count()) {
        console.log("点击内容检测方式：仅基础检测。");
        await button.click({ timeout: 3000 });
        await wait(2000);
        return true;
      }
      console.log("未找到精确“仅基础检测”按钮，暂停等待手动处理。");
      return false;
    }
  } catch {}
  return false;
}

async function handlePublishSettings(page) {
  const modal = page.locator(".arco-modal").filter({ hasText: /发布设置|是否使用AI|确认发布/ }).last();
  try {
    if (!(await modal.count()) || !(await modal.isVisible())) return false;

    await wait(2000);
    await chooseAiYesInPublishSettings(page);
    await wait(2000);

    const confirm = modal.locator(".arco-modal-footer button.arco-btn-primary").filter({ hasText: /^确认发布$/ }).last();
    if (await confirm.count()) {
      console.log("点击发布设置：确认发布。");
      await confirm.click({ timeout: 3000 });
      await wait(2500);
      return true;
    }

    console.log("未找到精确“确认发布”按钮，暂停等待手动处理。");
    return false;
  } catch {
    return false;
  }
}

async function chooseAiYesInPublishSettings(page) {
  const clicked = await page.evaluate(() => {
    const modals = Array.from(document.querySelectorAll(".arco-modal"))
      .filter((modal) => /发布设置|是否使用AI/.test(modal.textContent || ""));
    const modal = modals.at(-1);
    if (!modal) return false;

    const candidates = Array.from(modal.querySelectorAll("label, .arco-radio, span"));
    const yes = candidates.find((node) => (node.textContent || "").trim() === "是");
    const clickable = yes?.closest("label, .arco-radio") || yes;
    if (!clickable) return false;
    clickable.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
    return true;
  }).catch(() => false);
  if (clicked) console.log("发布设置：已选择是否使用AI=是。");
  return clicked;
}

async function confirmPublishDialogs(page) {
  let publishSettingsConfirmClicks = 0;
  let genericConfirmClicks = 0;
  for (let i = 0; i < 8; i++) {
    const handledCheckFirst = await clickBasicCheck(page);
    if (handledCheckFirst) {
      await wait(2000);
      continue;
    }

    const beforeBlock = await detectPublishBlock(page);
    if (beforeBlock) {
      const reason = formatPublishBlockReason(beforeBlock);
      console.log(`发布流程停止：${reason}`);
      return { blocked: true, reason };
    }

    const typoModalVisible = await page.locator(".arco-modal").filter({ hasText: /检测到你还存错别字未修改|是否确定提交/ }).last().isVisible().catch(() => false);
    const handledTypo = await clickTypoSubmit(page);
    if (handledTypo) {
      await wait(2000);
      const block = await detectPublishBlock(page);
      if (block) {
        const reason = formatPublishBlockReason(block);
        console.log(`发布流程停止：${reason}`);
        return { blocked: true, reason };
      }
      continue;
    }
    if (typoModalVisible) return { needsManual: true, reason: "错别字提示弹窗未能精确点击提交" };

    const handledPublishSettings = await handlePublishSettings(page);
    if (handledPublishSettings) {
      publishSettingsConfirmClicks++;
      await wait(2500);
      const block = await detectPublishBlock(page);
      if (block) {
        const reason = formatPublishBlockReason(block);
        console.log(`发布流程停止：${reason}`);
        return { blocked: true, reason };
      }
      if (await isPublishSettingsModalVisible(page)) {
        const reason = "发布被后台拦截：确认发布后发布设置弹窗仍未关闭，可能已被后台限制或拦截，已停止继续点击";
        console.log(`发布流程停止：${reason}`);
        return { blocked: true, reason };
      }
      if (publishSettingsConfirmClicks >= 2) {
        const reason = "发布被后台拦截：发布设置确认按钮已连续触发 2 次但未完成，已停止继续点击";
        console.log(`发布流程停止：${reason}`);
        return { blocked: true, reason };
      }
      continue;
    }

    const handledPublish = await clickDialogButton(page, ["确认发布", "确定发布"], 900);
    if (handledPublish) {
      genericConfirmClicks++;
      await wait(2000);
      const block = await detectPublishBlock(page);
      if (block) {
        const reason = formatPublishBlockReason(block);
        console.log(`发布流程停止：${reason}`);
        return { blocked: true, reason };
      }
      if (genericConfirmClicks >= 2) {
        const reason = "发布被后台拦截：确认发布按钮已连续触发 2 次但未完成，已停止继续点击";
        console.log(`发布流程停止：${reason}`);
        return { blocked: true, reason };
      }
      continue;
    }

    break;
  }
  return { needsManual: false };
}

async function isPublishSettingsModalVisible(page) {
  return page.locator(".arco-modal").filter({ hasText: /发布设置|是否使用AI|确认发布/ }).last().isVisible().catch(() => false);
}

function formatPublishBlockReason(block) {
  const prefix = block.type === "daily-limit" ? "触发当日发布字数/章节限制" : "发布被后台拦截";
  return `${prefix}：${block.message}`;
}

function isPublishBlockReason(reason) {
  return /触发当日发布字数\/章节限制|发布被后台拦截|每日上限|今日.*上限|字数.*上限|提交字数超出/.test(String(reason || ""));
}

async function detectPublishBlock(page) {
  return page.evaluate(() => {
    const normalize = (value) => String(value || "").replace(/\s+/g, "");
    const checks = [
      { type: "daily-limit", re: /(今日|当日|当天|每日).{0,12}(发布|更新|上传|提交).{0,12}(上限|限制|额度|已满)/ },
      { type: "daily-limit", re: /(发布|更新|上传|提交).{0,12}(字数|章节).{0,12}(上限|限制|额度|已满)/ },
      { type: "daily-limit", re: /(字数|章节).{0,12}(超出|超过|达到).{0,12}(每日|今日|当日|当天).{0,12}(上限|限制|额度)/ },
      { type: "daily-limit", re: /(超出|超过|达到).{0,12}(今日|当日|当天|每日).{0,12}(字数|发布|更新|上传|提交)/ },
      { type: "daily-limit", re: /(今日|当日|当天).{0,12}(字数).{0,12}(不足|不够|已用完)/ },
      { type: "daily-limit", re: /提交字数超出每日上限/ },
      { type: "daily-limit", re: /(字数|章节|提交).{0,18}(超出|超过|达到|已达).{0,18}(上限|限制|额度)/ },
      { type: "blocked", re: /(发布失败|提交失败|保存失败|上传失败|发布异常|上传异常|提交异常|保存异常|请稍后再试|内容未通过|无法发布|无法提交|无法上传)/ },
      { type: "blocked", re: /(标题|正文|内容|章节|字数).{0,18}(为空|不足|过短|不合法|不符合|未填写|缺失|重复)/ },
      { type: "blocked", re: /(弹窗|提示|错误|异常).{0,18}(失败|无法|不能|上限|限制)/ },
    ];
    const candidates = [
      ...Array.from(document.querySelectorAll(".arco-message, .arco-message-wrapper, .arco-notification, .arco-notification-wrapper, .semi-toast, .semi-toast-wrapper, [role='alert'], [class*='message'], [class*='toast'], [class*='notification']")),
      ...Array.from(document.querySelectorAll(".arco-modal, [role='dialog'], .semi-modal")),
      document.body,
    ]
      .filter(Boolean)
      .map((node) => normalize(node.innerText || node.textContent || ""))
      .filter(Boolean);
    let hit = null;
    let message = "";
    for (const candidate of candidates) {
      if (/请选择内容检测方式|仅基础检测|全面检测/.test(candidate)) continue;
      if (/发布设置|是否使用AI|确认发布/.test(candidate)) continue;
      hit = checks.find((item) => item.re.test(candidate));
      if (hit) {
        message = candidate;
        break;
      }
    }
    if (!hit) return null;
    return {
      type: hit.type,
      message: message.slice(0, 240),
    };
  }).catch(() => null);
}

async function ensurePublishNotBlocked(page, chapter) {
  await wait(1200);
  const block = await detectPublishBlock(page);
  if (!block) return;
  const prefix = block.type === "daily-limit" ? "触发当日发布字数/章节限制" : "发布被后台拦截";
  throw new Error(`第 ${chapter.no} 章${prefix}：${block.message}`);
}

async function chooseAiYes(page) {
  const ok = await page.evaluate(() => {
    const textOf = (node) => (node.textContent || "").replace(/\s+/g, "");
    const labels = Array.from(document.querySelectorAll("label, .arco-radio, .arco-radio-group, div, span"));
    const aiArea = labels.find((node) => textOf(node).includes("是否使用AI"));
    if (!aiArea) return false;

    const container = aiArea.closest(".arco-modal, .arco-modal-content, [role='dialog'], body") || document.body;
    const candidates = Array.from(container.querySelectorAll("label, .arco-radio, span, div, input"));
    for (const candidate of candidates) {
      const text = textOf(candidate);
      if (text === "是" || text.endsWith("是")) {
        const clickable = candidate.closest("label, .arco-radio") || candidate;
        clickable.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
        return true;
      }
    }
    return false;
  }).catch(() => false);
  if (ok) await wait(2000);
}

async function publishDraftChapter(page, chapter) {
  await dismissTutorialOverlays(page);
  const row = await findDraftRowAcrossPages(page, chapter);
  if (!row) {
    return { ok: false, reason: "草稿箱翻页查找后仍未找到对应草稿行" };
  }
  const clicked = await clickPublishInDraftRow(page, row);
  if (!clicked) return { ok: false, reason: "未找到草稿行里的发布按钮" };
  if (clicked === "opened-editor") {
    const editorPage = await selectEditorPage(page.context(), page);
    const currentResult = await publishCurrentEditorDraft(editorPage, chapter);
    if (currentResult.ok) return currentResult;
    return { ok: false, reason: `已进入草稿编辑页，但发布失败：${currentResult.reason}` };
  }
  await wait(800);
  const dialogResult = await confirmPublishDialogs(page);
  if (dialogResult?.blocked) return { ok: false, reason: dialogResult.reason };
  if (dialogResult?.needsManual) return { ok: false, reason: dialogResult.reason };
  const block = await detectPublishBlock(page);
  if (block) return { ok: false, reason: `发布被后台拦截：${block.message}` };
  const confirmed = await waitForPublishConfirmed(page);
  if (!confirmed.ok) return { ok: false, reason: confirmed.reason };
  return { ok: true };
}

async function ensureDraftBoxTab(page) {
  const draftTab = page.locator("text=草稿箱").first();
  try {
    if (await draftTab.count()) {
      console.log("点击确认进入草稿箱。");
      await draftTab.click({ timeout: 2500 });
      await wait(1800);
    }
  } catch {}
}

async function goNextDraftPage(page) {
  const clickedArrow = await page.evaluate(() => {
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const arrows = Array.from(document.querySelectorAll("svg.arco-icon-right, .arco-icon-right"))
      .filter(isVisible);
    for (const arrow of arrows) {
      const clickable = arrow.closest("button, li, .arco-pagination-item, .arco-pagination-next, span, div");
      if (!clickable || !isVisible(clickable)) continue;
      const className = String(clickable.className || "");
      if (className.includes("disabled") || clickable.getAttribute("aria-disabled") === "true") continue;
      clickable.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
      return true;
    }
    return false;
  }).catch(() => false);
  if (clickedArrow) {
    console.log("点击草稿箱分页右箭头。");
    await wait(1800);
    return true;
  }

  const selectors = [
    ".arco-pagination-next:not(.arco-pagination-disabled)",
    "li[aria-label='Next']:not(.arco-pagination-disabled)",
    "button[aria-label='Next']",
  ];
  for (const selector of selectors) {
    const next = page.locator(selector).last();
    try {
      if (await next.count() && await next.isVisible()) {
        const disabled = await next.evaluate((el) => el.className.includes("disabled") || el.getAttribute("aria-disabled") === "true" || el.disabled).catch(() => false);
        if (!disabled) {
          console.log("当前页未找到目标草稿，翻到下一页继续查找。");
          await next.click({ timeout: 2500 });
          await wait(1600);
          return true;
        }
      }
    } catch {}
  }
  const clicked = await clickByTexts(page, ["下一页", ">"], { timeout: 1200 });
  if (clicked) {
    await wait(1600);
    return true;
  }
  return false;
}

async function findDraftRowAcrossPages(page, chapter, maxPages = 10) {
  for (let i = 0; i < maxPages; i++) {
    await ensureDraftBoxTab(page);
    const row = await findDraftRowForChapter(page, chapter);
    if (row) return row;
    const moved = await goNextDraftPage(page);
    if (!moved) return null;
  }
  return null;
}

async function getCurrentEditorChapterInfo(page) {
  return page.evaluate(() => {
    const numberInput = document.querySelector("input.serial-input.byte-input.byte-input-size-default");
    const titleInput = document.querySelector("input.serial-input.serial-editor-input-hint-area.byte-input.byte-input-size-default, input[placeholder='请输入标题'], input[placeholder*='标题']");
    const editor = document.querySelector(".ProseMirror[contenteditable='true'], [contenteditable='true'].ProseMirror");
    return {
      chapterNo: numberInput?.value || numberInput?.getAttribute("value") || "",
      title: titleInput?.value || titleInput?.getAttribute("value") || "",
      hasEditor: Boolean(editor),
      url: location.href,
    };
  }).catch(() => ({ chapterNo: "", title: "", hasEditor: false, url: page.url() }));
}

async function publishCurrentEditorDraft(page, chapter) {
  const info = await getCurrentEditorChapterInfo(page);
  if (!info.hasEditor) return { ok: false, reason: "当前页不是编辑页" };

  const pageNo = String(info.chapterNo || "").trim();
  const pageTitle = String(info.title || "").trim();
  const expectedNo = String(chapter.chapterNoText || chapter.no);
  const noMatches = pageNo === expectedNo || Number(pageNo) === Number(expectedNo);
  const titleMatches = pageTitle === chapter.title || pageTitle.includes(chapter.title) || chapter.title.includes(pageTitle);

  if (!noMatches || !titleMatches) {
    return {
      ok: false,
      reason: `当前编辑页不匹配。页面章节号="${pageNo}" 标题="${pageTitle}"，目标章节号="${expectedNo}" 标题="${chapter.title}"`,
    };
  }

  console.log(`当前已在第 ${chapter.no} 章草稿编辑页，直接进入发布流程。`);
  const clicked = await clickByTexts(page, ["下一步", "发布", "发表", "提交发布", "立即发布"], { timeout: 3000 });
  if (!clicked) return { ok: false, reason: "当前编辑页未找到下一步/发布按钮" };
  await wait(1500);

  const dialogResult = await confirmPublishDialogs(page);
  if (dialogResult?.blocked) return { ok: false, reason: dialogResult.reason };
  if (dialogResult?.needsManual) return { ok: false, reason: dialogResult.reason };
  const confirmed = await waitForPublishConfirmed(page);
  if (!confirmed.ok) return { ok: false, reason: confirmed.reason };
  return { ok: true };
}

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function copyToClipboard(page, text) {
  await page.evaluate(async (value) => {
    await navigator.clipboard.writeText(value);
  }, text);
}

function printQualityReport(chapters, issues) {
  const counts = chapters.map((chapter) => chapter.platformChars ?? chapter.chars);
  const min = Math.min(...counts);
  const max = Math.max(...counts);
  console.log(`本地检查：${chapters.length} 章，按平台口径最短 ${min} 字，最长 ${max} 字`);
  if (!issues.length) {
    console.log("检查通过：没有发现阻断问题。");
    return;
  }

  const errors = issues.filter((issue) => issue.level === "error");
  const warnings = issues.filter((issue) => issue.level === "warn");
  console.log(`发现 ${errors.length} 个错误，${warnings.length} 个警告：`);
  for (const issue of issues.slice(0, 30)) {
    console.log(`[${issue.level}] 第${issue.no}章：${issue.message}`);
  }
  if (issues.length > 30) console.log(`其余 ${issues.length - 30} 条已省略。`);
}

async function launchBrowser(args) {
  const edgePath = EDGE_PATHS.find((item) => fs.existsSync(item));
  const launchOptions = {
    headless: args.headless,
    viewport: { width: 1440, height: 1000 },
  };
  if (edgePath) {
    launchOptions.executablePath = edgePath;
    console.log(`使用系统 Edge 启动浏览器：${edgePath}`);
  } else {
    launchOptions.channel = "msedge";
  }
  try {
    return await chromium.launchPersistentContext(USER_DATA_DIR, launchOptions);
  } catch (error) {
    if (edgePath) throw error;
    console.log(`系统 Edge 启动失败，尝试使用 Playwright Chromium：${error.message}`);
    return chromium.launchPersistentContext(USER_DATA_DIR, {
      headless: args.headless,
      viewport: { width: 1440, height: 1000 },
    });
  }
}

async function closeBrowserContext(browser) {
  if (!browser) return;
  await browser.close().catch(() => {});
}

async function pauseForManualFailureReview(rl, error) {
  const message = error?.message || String(error || "未知错误");
  console.log(`任务已暂停，浏览器页面已保留用于人工检查。失败原因：${message}`);
  console.log("请在浏览器中检查当前弹窗、章节内容和后台状态。处理完成后，可在网页点“继续 / 回车”让任务退出并记录失败。");
  try {
    await rl.question("人工检查完成后按回车退出当前失败任务...");
  } catch {}
}

async function main() {
  const args = normalizeArgs(parseArgs(process.argv));
  if (args.help) return printHelp();
  if (!args.chapters) {
    throw new Error("请用 --chapters 指定章节目录，或用 --config 指定配置文件。");
  }
  if (!fs.existsSync(args.chapters)) throw new Error(`章节目录不存在：${args.chapters}`);

  const chapters = readChapters(args.chapters, args.start, args.end);
  if (!chapters.length) throw new Error("没有找到符合范围的章节。");

  const issues = validateChapters(chapters, args);
  printQualityReport(chapters, issues);
  const hasError = issues.some((issue) => issue.level === "error");
  const hasWarning = issues.some((issue) => issue.level === "warn");
  if (hasError || (args.strictQuality && hasWarning)) {
    if (args.dryRun || args.mode === "dry-run") return;
    throw new Error("发布前检查未通过。可先修正文稿，或加 --no-strict-quality 忽略警告。错误不能忽略。");
  }
  if (args.dryRun || args.mode === "dry-run") return;

  const runId = makeRunId(args);
  const state = loadState(runId, args);
  saveState(runId, state);
  const completed = new Set(state.completed);
  const pending = chapters.filter((chapter) => !completed.has(chapter.no));
  console.log(`书名/项目：${args.book}`);
  if (args.backendBook && args.backendBook !== args.book) console.log(`后台作品：${args.backendBook}`);
  console.log(`章节目录：${args.chapters}`);
  console.log(`运行模式：${args.mode === "publish-drafts" ? "发布草稿箱章节" : args.mode === "upload-and-publish" ? "填写后直接发布" : args.mode === "publish" ? "正式发布" : "保存草稿"}`);
  console.log(`断点：已完成 ${completed.size} 章，待处理 ${pending.length} 章。记录目录：${RUNS_DIR}`);
  logLine(runId, `开始运行，待处理 ${pending.length} 章，模式 ${args.mode}`);

  const browser = await launchBrowser(args);
  const page = browser.pages()[0] || await browser.newPage();
  await page.goto(args.url, { waitUntil: "domcontentloaded" });

  const rl = readline.createInterface({ input, output });
  if (args.autoStart) {
    console.log(`自动运行模式：已打开目标后台 URL：${args.url}`);
    await wait(2500);
  } else {
    await rl.question("请在浏览器里登录，并进入目标作品的“章节管理/新建章节”页面。准备好后按回车继续...");
  }

  const pageBook = args.backendBook || args.book;
  let editorPage = (args.mode === "draft" || args.mode === "upload-and-publish")
    ? await ensureEditorPageForDraft(browser, page, pageBook)
    : await selectEditorPage(browser, page);
  if (args.mode === "publish-drafts") {
    editorPage = await selectChapterManagePage(browser, page);
  }
  if (editorPage !== page) {
    console.log(`已切换到检测到编辑器的标签页：${editorPage.url()}`);
  }
  const newChapterUrl = args.newUrl || "";
  if (!newChapterUrl) {
    console.log("未提供 --new-url。保存后会尝试从其他标签页点击“新建章节”；建议保留章节管理页打开。");
  }

  if (args.inspect) {
    await inspectPage(editorPage, runId);
    rl.close();
    await closeBrowserContext(browser);
    console.log("诊断完成，没有填写任何内容。");
    return;
  }

  if (args.mode === "publish-drafts") {
    console.log("草稿发布模式：请确保当前页面是草稿箱或章节管理页，且能看到待发布章节列表。");
    let processedDrafts = 0;
    for (const chapter of pending) {
      console.log(`准备发布第 ${chapter.no} 章：${chapter.title}`);
      logLine(runId, `准备发布草稿第 ${chapter.no} 章：${chapter.title}`);
      try {
        const result = await publishDraftChapter(editorPage, chapter);
        if (!result.ok) {
          await saveFailure(editorPage, runId, chapter, result.reason);
          console.log(`第 ${chapter.no} 章未能自动发布：${result.reason}`);
          if (args.autoStart) {
            throw new Error(`第 ${chapter.no} 章发布失败：${result.reason}`);
          }
          if (isPublishBlockReason(result.reason)) {
            throw new Error(`第 ${chapter.no} 章${result.reason}`);
          }
          await rl.question("请手动处理该章，完成后按回车继续，或按 Ctrl+C 停止...");
        } else {
          console.log(`第 ${chapter.no} 章草稿发布已确认完成。`);
        }
        state.completed.push(chapter.no);
        saveState(runId, state);
        processedDrafts++;
        if (args.confirmEach) {
          await rl.question(`第 ${chapter.no} 章处理完成。检查后台后按回车继续...`);
        }
        if (args.confirmEvery > 0 && processedDrafts % args.confirmEvery === 0) {
          await rl.question(`已处理 ${processedDrafts} 章。检查后台后按回车继续...`);
        }
      } catch (error) {
        state.failed.push({ no: chapter.no, message: error.message || String(error), time: new Date().toISOString() });
        saveState(runId, state);
        await saveFailure(editorPage, runId, chapter, error.message || String(error));
        await pauseForManualFailureReview(rl, error);
        throw error;
      }
    }
    rl.close();
    logLine(runId, "草稿发布模式运行完成");
    console.log("草稿发布处理完成。");
    await closeBrowserContext(browser);
    return;
  }

  let processedThisRun = 0;
  let currentEditorPage = editorPage;
  for (let index = 0; index < pending.length; index++) {
    const chapter = pending[index];
    console.log(`开始第 ${chapter.no} 章：${chapter.title}`);
    logLine(runId, `开始第 ${chapter.no} 章：${chapter.title}`);

    try {
      const dismissed = await dismissTutorialOverlays(currentEditorPage);
      if (dismissed) console.log(`已处理 ${dismissed} 步页面教程/引导遮罩。`);

      const newChapterClicked = await clickNewChapterButton(currentEditorPage, { book: pageBook, timeout: 2500 });
      if (!newChapterClicked) console.log("未找到“新建章节”按钮，将尝试在当前页面直接填写。");
      await wait(600);
      await dismissTutorialOverlays(currentEditorPage);

      const numberOk = await fillChapterNumber(currentEditorPage, chapter.chapterNoText);
      if (!numberOk) console.log(`未找到独立章节序号输入框，将只填写章节名：${chapter.title}`);

      const titleOk = await fillTitle(currentEditorPage, chapter.title);
      const bodyOk = await fillBodyAndCleanHeading(currentEditorPage, chapter);
      if (!titleOk || !bodyOk) {
        await copyToClipboard(currentEditorPage, `第${chapter.chapterNoText}章 ${chapter.title}\n\n${chapter.body}`);
        await saveFailure(currentEditorPage, runId, chapter, "未能自动定位标题或正文输入框");
        console.log(`第 ${chapter.no} 章未能自动定位输入框。内容已复制到剪贴板，请手动粘贴。`);
        if (args.autoStart) throw new Error(`第 ${chapter.no} 章未能自动定位标题或正文输入框，自动任务已停止。`);
        await rl.question("手动处理完成后按回车继续，或按 Ctrl+C 停止...");
      } else {
        if (args.confirmEach) {
          await rl.question(`第 ${chapter.no} 章已填写。检查页面后按回车${args.mode === "publish" || args.mode === "upload-and-publish" ? "发布" : "保存草稿"}...`);
        }

        const submitMode = args.mode === "upload-and-publish" ? "publish" : args.mode;
        await dismissTutorialOverlays(currentEditorPage);
        if (args.mode === "draft") {
          const ready = await verifyDraftContentReady(currentEditorPage, chapter);
          if (!ready.ok) {
            const reason = `保存前内容校验失败：章节号=${ready.actualNumber || "-"}，标题=${ready.actualTitle || "-"}，正文字数=${ready.bodyLength || 0}`;
            await saveFailure(currentEditorPage, runId, chapter, reason);
            throw new Error(reason);
          }
        }
        const submitOk = await submitChapter(currentEditorPage, submitMode);
        if (!submitOk) {
          await saveFailure(currentEditorPage, runId, chapter, "未找到保存或发布按钮");
          console.log(`第 ${chapter.no} 章已填写，但未找到保存/发布按钮。请手动点击。`);
          if (args.autoStart) throw new Error(`第 ${chapter.no} 章未找到保存或发布按钮，自动任务已停止。`);
          await rl.question("手动点击完成后按回车继续，或按 Ctrl+C 停止...");
          if (args.mode === "upload-and-publish") {
            const dialogResult = await confirmPublishDialogs(currentEditorPage);
            if (dialogResult?.blocked) {
              await saveFailure(currentEditorPage, runId, chapter, dialogResult.reason);
              throw new Error(`第 ${chapter.no} 章${dialogResult.reason}`);
            }
            if (dialogResult?.needsManual) {
              console.log(`发布弹窗需要手动处理：${dialogResult.reason}`);
              if (args.autoStart) throw new Error(`第 ${chapter.no} 章发布弹窗需要手动处理：${dialogResult.reason}`);
              await rl.question("手动处理完成后按回车继续，或按 Ctrl+C 停止...");
            }
          }
          if (args.mode === "upload-and-publish") await ensurePublishNotBlocked(currentEditorPage, chapter);
          if (args.mode === "upload-and-publish") {
            const published = await waitForPublishConfirmed(currentEditorPage);
            if (!published.ok) {
              await saveFailure(currentEditorPage, runId, chapter, published.reason);
              throw new Error(`第 ${chapter.no} 章${published.reason}`);
            }
          }
        } else {
          if (args.mode === "upload-and-publish") {
            const dialogResult = await confirmPublishDialogs(currentEditorPage);
            if (dialogResult?.blocked) {
              await saveFailure(currentEditorPage, runId, chapter, dialogResult.reason);
              throw new Error(`第 ${chapter.no} 章${dialogResult.reason}`);
            }
            if (dialogResult?.needsManual) {
              console.log(`发布弹窗需要手动处理：${dialogResult.reason}`);
              if (args.autoStart) throw new Error(`第 ${chapter.no} 章发布弹窗需要手动处理：${dialogResult.reason}`);
              await rl.question("手动处理完成后按回车继续，或按 Ctrl+C 停止...");
            }
          }
          if (args.mode === "upload-and-publish") await ensurePublishNotBlocked(currentEditorPage, chapter);
          await wait(args.delay);
          if (args.mode === "draft") {
            const saved = await waitForDraftSaved(currentEditorPage);
            if (!saved.ok) {
              await saveFailure(currentEditorPage, runId, chapter, saved.reason);
              throw new Error(`第 ${chapter.no} 章${saved.reason}，已停止以避免生成空白草稿。`);
            }
            console.log(`第 ${chapter.no} 章草稿已确认保存。`);
          } else if (args.mode === "upload-and-publish" || args.mode === "publish") {
            const published = await waitForPublishConfirmed(currentEditorPage);
            if (!published.ok) {
              await saveFailure(currentEditorPage, runId, chapter, published.reason);
              throw new Error(`第 ${chapter.no} 章${published.reason}`);
            }
            console.log(`第 ${chapter.no} 章发布已确认成功。`);
          }
        }
      }

      if (args.mode === "publish") await ensurePublishNotBlocked(currentEditorPage, chapter);
      state.completed.push(chapter.no);
      saveState(runId, state);
      processedThisRun++;
      logLine(runId, `完成第 ${chapter.no} 章`);

      if (args.confirmEvery > 0 && processedThisRun % args.confirmEvery === 0) {
        await rl.question(`已处理 ${processedThisRun} 章。检查后台后按回车继续...`);
      }

      const hasNext = index < pending.length - 1;
      if (hasNext) {
        console.log("当前章已保存，正在关闭当前编辑页并打开新的章节编辑页...");
        const nextPage = await openFreshChapterPage(browser, currentEditorPage, newChapterUrl, pageBook, args.url);
        await wait(1200);
        await dismissTutorialOverlays(nextPage);
        await currentEditorPage.close({ runBeforeUnload: false }).catch(() => {});
        currentEditorPage = await selectEditorPage(browser, nextPage);
      }
    } catch (error) {
      state.failed.push({ no: chapter.no, message: error.message || String(error), time: new Date().toISOString() });
      saveState(runId, state);
      await saveFailure(currentEditorPage, runId, chapter, error.message || String(error));
      await pauseForManualFailureReview(rl, error);
      throw error;
    }
  }

  rl.close();
  logLine(runId, "运行完成");
  await closeBrowserContext(browser);
  console.log("处理完成。浏览器已自动关闭。");
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
