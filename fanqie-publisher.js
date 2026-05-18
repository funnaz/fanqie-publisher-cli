#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const readline = require("readline/promises");
const { stdin: input, stdout: output } = require("process");
const { chromium } = require("playwright");

const DEFAULT_CHAPTERS_DIR = path.join(process.cwd(), "苍生印_重写版", "chapters");
const USER_DATA_DIR = path.join(process.cwd(), ".fanqie-browser-profile");
const RUNS_DIR = path.join(process.cwd(), ".fanqie-runs");
const DEFAULT_MIN_CHARS = 950;

function parseArgs(argv) {
  const args = {
    chapters: DEFAULT_CHAPTERS_DIR,
    start: 1,
    end: Infinity,
    mode: "draft",
    delay: 1200,
    url: "https://fanqienovel.com/writer/zone",
    newUrl: "",
    headless: false,
    minChars: DEFAULT_MIN_CHARS,
    confirmEach: false,
    confirmEvery: 0,
    resume: true,
    reset: false,
    dryRun: false,
    strictQuality: true,
    inspect: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const key = argv[i];
    const next = argv[i + 1];
    if (key === "--chapters" && next) args.chapters = path.resolve(next), i++;
    else if (key === "--start" && next) args.start = Number(next), i++;
    else if (key === "--end" && next) args.end = Number(next), i++;
    else if (key === "--url" && next) args.url = next, i++;
    else if (key === "--new-url" && next) args.newUrl = next, i++;
    else if (key === "--delay" && next) args.delay = Number(next), i++;
    else if (key === "--mode" && next) args.mode = next, i++;
    else if (key === "--min-chars" && next) args.minChars = Number(next), i++;
    else if (key === "--confirm-each") args.confirmEach = true;
    else if (key === "--confirm-every" && next) args.confirmEvery = Number(next), i++;
    else if (key === "--no-resume") args.resume = false;
    else if (key === "--reset") args.reset = true;
    else if (key === "--dry-run") args.dryRun = true, args.mode = "dry-run";
    else if (key === "--publish") args.mode = "publish";
    else if (key === "--draft") args.mode = "draft";
    else if (key === "--no-strict-quality") args.strictQuality = false;
    else if (key === "--inspect-page") args.inspect = true;
    else if (key === "--headless") args.headless = true;
    else if (key === "--help" || key === "-h") args.help = true;
  }

  if (!["dry-run", "draft", "publish"].includes(args.mode)) {
    throw new Error("--mode 只能是 dry-run、draft 或 publish");
  }
  return args;
}

function printHelp() {
  console.log(`
番茄发布助手 CLI

用法：
  npm run fanqie -- --dry-run --start 1 --end 10
  npm run fanqie -- --draft --start 1 --end 3
  npm run fanqie -- --publish --start 1 --end 3 --confirm-each

常用参数：
  --chapters        章节目录，默认：苍生印_重写版\\chapters
  --start           起始章节号，默认 1
  --end             结束章节号，默认全部
  --dry-run         只做本地检查，不打开浏览器，不填后台
  --draft           保存草稿模式，默认模式
  --publish         正式发布模式
  --confirm-each    每章填完后暂停确认
  --confirm-every   每 N 章暂停确认一次
  --reset           清空本次范围的断点记录，从头处理
  --no-resume       忽略断点记录，但不删除记录文件
  --min-chars       最低字数，默认 950
  --delay           每章提交后等待毫秒数，默认 1200
  --url             打开的后台地址
  --new-url         真正的新建章节 URL。保存后每章用它打开新页面，避免复制编辑草稿 URL
  --inspect-page    登录并进入编辑页后，只导出页面诊断，不填写内容

流程：
  1. 先运行 --dry-run 检查章节质量。
  2. 再运行 --draft 保存少量章节为草稿。
  3. 确认后台显示正常后，再扩大范围或使用 --publish。
`);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function safeName(text) {
  return String(text).replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 120);
}

function chapterNo(file) {
  const m = path.basename(file).match(/^(\d+)-/);
  return m ? Number(m[1]) : 0;
}

function parseChapterHeading(firstLine, fallbackNo, file) {
  const fallbackTitle = path.basename(file, ".txt").replace(/^\d+-/, "").trim();
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
    if (chapter.chars < args.minChars) issues.push({ level: "error", no: chapter.no, message: `正文不足 ${args.minChars} 字，当前 ${chapter.chars} 字` });
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
  return safeName(`${chapterRoot}_${args.start}_${Number.isFinite(args.end) ? args.end : "all"}_${args.mode}`);
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

async function openFreshChapterPage(browser, currentPage, newChapterUrl) {
  if (newChapterUrl) {
    const nextPage = await browser.newPage();
    await nextPage.goto(newChapterUrl, { waitUntil: "domcontentloaded" });
    return nextPage;
  }

  const managerCandidates = browser.pages().filter((page) => page !== currentPage && !page.isClosed());
  for (const page of managerCandidates) {
    const clicked = await clickByTexts(page, ["新建章节", "新建", "添加章节", "写新章节", "创建章节"], { timeout: 1800 });
    if (clicked) {
      await wait(1200);
      return selectEditorPage(browser, page);
    }
  }

  const nextPage = await browser.newPage();
  await nextPage.goto("https://fanqienovel.com/writer/zone", { waitUntil: "domcontentloaded" });
  console.log("没有提供 --new-url，也没有在其他标签页找到“新建章节”按钮。请手动打开新的章节编辑页。");
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

async function submitChapter(page, mode) {
  if (mode === "publish") {
    return clickByTexts(page, ["发布", "发表", "提交发布", "立即发布"], { timeout: 3500 });
  }
  return clickByTexts(page, ["保存草稿", "存草稿", "保存", "暂存"], { timeout: 3500 });
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
  const counts = chapters.map((chapter) => chapter.chars);
  const min = Math.min(...counts);
  const max = Math.max(...counts);
  console.log(`本地检查：${chapters.length} 章，最短 ${min} 字，最长 ${max} 字`);
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
  return chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: args.headless,
    channel: "msedge",
    viewport: { width: 1440, height: 1000 },
  }).catch(async () => chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: args.headless,
    viewport: { width: 1440, height: 1000 },
  }));
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) return printHelp();
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
  const completed = new Set(state.completed);
  const pending = chapters.filter((chapter) => !completed.has(chapter.no));
  console.log(`运行模式：${args.mode === "publish" ? "正式发布" : "保存草稿"}`);
  console.log(`断点：已完成 ${completed.size} 章，待处理 ${pending.length} 章。记录目录：${RUNS_DIR}`);
  logLine(runId, `开始运行，待处理 ${pending.length} 章，模式 ${args.mode}`);

  const browser = await launchBrowser(args);
  const page = browser.pages()[0] || await browser.newPage();
  await page.goto(args.url, { waitUntil: "domcontentloaded" });

  const rl = readline.createInterface({ input, output });
  await rl.question("请在浏览器里登录，并进入目标作品的“章节管理/新建章节”页面。准备好后按回车继续...");

  const editorPage = await selectEditorPage(browser, page);
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
    console.log("诊断完成，没有填写任何内容。");
    return;
  }

  let processedThisRun = 0;
  let currentEditorPage = editorPage;
  for (let index = 0; index < pending.length; index++) {
    const chapter = pending[index];
    console.log(`开始第 ${chapter.no} 章：${chapter.title}`);
    logLine(runId, `开始第 ${chapter.no} 章：${chapter.title}`);

    try {
      const newChapterClicked = await clickByTexts(currentEditorPage, ["新建章节", "新建", "添加章节", "写新章节", "创建章节"], { timeout: 2500 });
      if (!newChapterClicked) console.log("未找到“新建章节”按钮，将尝试在当前页面直接填写。");
      await wait(600);

      const numberOk = await fillChapterNumber(currentEditorPage, chapter.chapterNoText);
      if (!numberOk) console.log(`未找到独立章节序号输入框，将只填写章节名：${chapter.title}`);

      const titleOk = await fillTitle(currentEditorPage, chapter.title);
      const bodyOk = await fillBodyAndCleanHeading(currentEditorPage, chapter);
      if (!titleOk || !bodyOk) {
        await copyToClipboard(currentEditorPage, `第${chapter.chapterNoText}章 ${chapter.title}\n\n${chapter.body}`);
        await saveFailure(currentEditorPage, runId, chapter, "未能自动定位标题或正文输入框");
        console.log(`第 ${chapter.no} 章未能自动定位输入框。内容已复制到剪贴板，请手动粘贴。`);
        await rl.question("手动处理完成后按回车继续，或按 Ctrl+C 停止...");
      } else {
        if (args.confirmEach) {
          await rl.question(`第 ${chapter.no} 章已填写。检查页面后按回车${args.mode === "publish" ? "发布" : "保存草稿"}...`);
        }

        const submitOk = await submitChapter(currentEditorPage, args.mode);
        if (!submitOk) {
          await saveFailure(currentEditorPage, runId, chapter, "未找到保存或发布按钮");
          console.log(`第 ${chapter.no} 章已填写，但未找到保存/发布按钮。请手动点击。`);
          await rl.question("手动点击完成后按回车继续，或按 Ctrl+C 停止...");
        } else {
          await wait(args.delay);
        }
      }

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
        const nextPage = await openFreshChapterPage(browser, currentEditorPage, newChapterUrl);
        await wait(1200);
        await currentEditorPage.close({ runBeforeUnload: false }).catch(() => {});
        currentEditorPage = await selectEditorPage(browser, nextPage);
      }
    } catch (error) {
      state.failed.push({ no: chapter.no, message: error.message || String(error), time: new Date().toISOString() });
      saveState(runId, state);
      await saveFailure(currentEditorPage, runId, chapter, error.message || String(error));
      throw error;
    }
  }

  rl.close();
  logLine(runId, "运行完成");
  console.log("处理完成。浏览器保持打开，方便你检查后台结果。");
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
