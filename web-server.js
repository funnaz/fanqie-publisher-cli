const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { chromium } = require("playwright");

const ROOT = process.cwd();
const PUBLIC_DIR = path.join(ROOT, "public");
const RUNS_DIR = path.join(ROOT, ".fanqie-runs");
const SCHEDULES_PATH = path.join(ROOT, ".fanqie-schedules.json");
const SCHEDULE_HISTORY_PATH = path.join(ROOT, ".fanqie-schedule-history.json");
const PROJECTS_PATH = path.join(ROOT, ".fanqie-projects.json");
const STUDIO_AI_CONFIG_PATH = path.join(ROOT, ".studio-ai-config.json");
const WORKSPACE_ROOT = path.resolve(ROOT, "..");
const MAIN_NOVEL_DIR = path.join(WORKSPACE_ROOT, "苍生印_重写版");
const MAIN_CHAPTERS_DIR = path.join(MAIN_NOVEL_DIR, "chapters");
const LIBRARY_DIR = path.join(WORKSPACE_ROOT, "十部长篇玄幻");
const STUDIO_ROOT = path.join(WORKSPACE_ROOT, "AI小说工作室");
const STUDIO_OUTPUT_ROOT = path.join(STUDIO_ROOT, "生成作品");
const STUDIO_RUNS_DIR = path.join(ROOT, ".studio-runs");
const PORT = Number(process.env.PORT || 3899);
const BROWSER_PROFILE_DIR = path.join(WORKSPACE_ROOT, ".fanqie-browser-profile");
const CHROME_PATHS = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  path.join(process.env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe"),
];
const EDGE_PATHS = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];

let currentJob = null;
let studioJob = null;
let schedules = loadSchedules();
let scheduleHistory = loadScheduleHistory();
let projects = loadProjects();
const scheduleTimers = new Map();
const clients = new Set();
const memoryLogs = [];

function sendEvent(type, payload) {
  const line = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) res.write(line);
}

function appendLog(message) {
  const entry = { time: new Date().toISOString(), message: String(message) };
  memoryLogs.push(entry);
  if (memoryLogs.length > 500) memoryLogs.shift();
  sendEvent("log", entry);
  if (typeof getStatus === "function") sendEvent("status", getStatus());
}

function extractFailureReason(text) {
  const value = String(text || "").replace(/\r/g, "");
  const lines = value.split("\n").map((line) => line.trim()).filter(Boolean);
  const hit = [...lines].reverse().find((line) =>
    /^\[error\]/i.test(line)
    || /任务失败|上传失败|发布失败|保存失败|本地检查未通过|未检测到成功状态|未能自动|字数不足|有效正文不足|不达标|不存在|触发当日发布/.test(line)
  );
  return hit ? hit.replace(/^\[error\]\s*/i, "").slice(0, 500) : "";
}

function isManualPauseMessage(text) {
  return /任务已暂停，浏览器页面已保留用于人工检查|人工检查完成后按回车/.test(String(text || ""));
}

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => body += chunk);
    req.on("end", () => {
      try {
        if (body.charCodeAt(0) === 0xfeff) body = body.slice(1);
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

function safeFile(filePath) {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(PUBLIC_DIR)) return null;
  return resolved;
}

function contentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "application/javascript; charset=utf-8";
  return "application/octet-stream";
}

function normalizeMode(mode) {
  if (mode === "publish-drafts") return "--publish-drafts";
  if (mode === "upload-and-publish") return "--upload-and-publish";
  if (mode === "publish") return "--publish";
  if (mode === "dry-run") return "--dry-run";
  return "--draft";
}

function buildArgs(options) {
  const args = ["fanqie-publisher.js"];
  if (options.chapters) args.push("--chapters", options.chapters);
  if (options.config) args.push("--config", options.config);
  if (options.book) args.push("--book", options.book);
  const backendBook = options.backendBook || extractBackendBookFromUrl(options.url || "");
  if (backendBook) args.push("--backend-book", backendBook);
  args.push(normalizeMode(options.mode));
  if (options.start) args.push("--start", String(options.start));
  if (options.end) args.push("--end", String(options.end));
  if (options.confirmEach) args.push("--confirm-each");
  if (options.confirmEvery) args.push("--confirm-every", String(options.confirmEvery));
  if (options.reset) args.push("--reset");
  if (options.noResume) args.push("--no-resume");
  if (options.minChars) args.push("--min-chars", String(options.minChars));
  if (options.delay) args.push("--delay", String(options.delay));
  if (options.url) args.push("--url", options.url);
  if (options.newUrl) args.push("--new-url", options.newUrl);
  if (options.noStrictQuality) args.push("--no-strict-quality");
  if (options.inspectPage) args.push("--inspect-page");
  if (options.autoStart || (options.autoStart !== false && options.url)) args.push("--auto-start");
  return args;
}

function extractBackendBookFromUrl(value) {
  try {
    const pathname = new URL(String(value || "")).pathname;
    const raw = pathname.split("/").pop() || "";
    if (!raw.includes("&")) return "";
    return decodeURIComponent(raw.split("&").slice(1).join("&")).trim();
  } catch {
    return "";
  }
}

function buildStudioGenerateArgs(options) {
  fs.mkdirSync(STUDIO_RUNS_DIR, { recursive: true });
  const ai = resolveStudioAiConfig(options);
  const minWords = Math.max(600, Math.min(5000, Number(options.minWords || options.words || 1050)));
  const maxWords = Math.max(minWords, Math.min(5000, Number(options.maxWords || 1300)));
  const chapters = Math.max(1, Math.min(2000, Number(options.chapters || 3)));
  const batchSize = Math.max(1, Math.min(200, Number(options.batchSize || 10)));
  const config = {
    title: options.title || "未命名小说",
    genre: options.genre || "东方玄幻",
    premise: options.premise || "凡人少年在乱世中逆命而行。",
    audience: options.audience || "网文读者",
    chapters,
    words: minWords,
    minWords,
    maxWords,
    engine: options.engine === "template" ? "template" : "ai",
    model: ai.model || "",
    outputRoot: STUDIO_OUTPUT_ROOT,
    action: options.action === "batch" ? "batch" : "project",
    batchSize,
  };
  const configPath = path.join(STUDIO_RUNS_DIR, `generate-${Date.now()}.json`);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
  return [path.join("scripts", "studio-generator.js"), "--config", configPath];
}

function loadStudioAiConfig() {
  if (!fs.existsSync(STUDIO_AI_CONFIG_PATH)) return {};
  try {
    const data = JSON.parse(fs.readFileSync(STUDIO_AI_CONFIG_PATH, "utf8"));
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

function normalizeStudioAiConfig(raw = {}) {
  if (raw.profiles) {
    return {
      activeProvider: raw.activeProvider || raw.provider || "cloud",
      profiles: {
        cloud: raw.profiles.cloud || {},
        local: raw.profiles.local || {},
      },
    };
  }
  const provider = raw.provider || "cloud";
  return {
    activeProvider: provider,
    profiles: {
      cloud: provider === "cloud" ? raw : {},
      local: provider === "local" ? raw : {},
    },
  };
}

function saveStudioAiConfig(input) {
  const oldConfig = normalizeStudioAiConfig(loadStudioAiConfig());
  const provider = input.provider === "local" ? "local" : "cloud";
  const oldProfile = oldConfig.profiles[provider] || {};
  const nextProfile = {
    provider,
    baseUrl: String(input.baseUrl || oldProfile.baseUrl || "").trim().replace(/\/$/, ""),
    model: String(input.model || oldProfile.model || "").trim(),
    apiKey: oldProfile.apiKey || "",
    updatedAt: new Date().toISOString(),
  };
  const incomingKey = String(input.apiKey || "").trim();
  if (incomingKey) nextProfile.apiKey = incomingKey;
  if (input.clearApiKey) nextProfile.apiKey = "";

  if (provider === "local") {
    nextProfile.baseUrl = nextProfile.baseUrl || "http://127.0.0.1:11434/v1";
    nextProfile.model = nextProfile.model || process.env.AI_MODEL || "qwen2.5:3b";
    nextProfile.apiKey = nextProfile.apiKey || "ollama";
  } else {
    nextProfile.baseUrl = nextProfile.baseUrl || "https://api.openai.com/v1";
    nextProfile.model = nextProfile.model || "gpt-4.1-mini";
  }

  const next = {
    activeProvider: provider,
    profiles: {
      ...oldConfig.profiles,
      [provider]: nextProfile,
    },
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(STUDIO_AI_CONFIG_PATH, JSON.stringify(next, null, 2), "utf8");
  return publicStudioAiConfig(resolveStudioAiConfig());
}

function resolveStudioAiConfig(overrides = {}) {
  const saved = normalizeStudioAiConfig(loadStudioAiConfig());
  const provider = saved.activeProvider || (process.env.AI_BASE_URL ? "local" : "cloud");
  const profile = saved.profiles[provider] || {};
  const baseUrl = (
    overrides.baseUrl ||
    profile.baseUrl ||
    process.env.AI_BASE_URL ||
    process.env.OPENAI_BASE_URL ||
    "https://api.openai.com/v1"
  ).replace(/\/$/, "");
  const model =
    overrides.model ||
    profile.model ||
    process.env.AI_MODEL ||
    process.env.OPENAI_MODEL ||
    "gpt-4.1-mini";
  const apiKey = Object.prototype.hasOwnProperty.call(profile, "apiKey")
    ? profile.apiKey
    : (process.env.AI_API_KEY || process.env.OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY || "");
  return { provider, baseUrl, model, apiKey, profiles: saved.profiles, updatedAt: profile.updatedAt || saved.updatedAt || null };
}

function publicStudioAiConfig(config = resolveStudioAiConfig()) {
  const profileSummary = {};
  for (const provider of ["cloud", "local"]) {
    const profile = config.profiles?.[provider] || {};
    profileSummary[provider] = {
      configured: Boolean(profile.apiKey),
      hasApiKey: Boolean(profile.apiKey),
      model: profile.model || "",
      baseUrl: profile.baseUrl || "",
      updatedAt: profile.updatedAt || null,
    };
  }
  return {
    provider: config.provider || "cloud",
    configured: Boolean(config.apiKey),
    hasApiKey: Boolean(config.apiKey),
    model: config.model || "",
    baseUrl: config.baseUrl || "",
    updatedAt: config.updatedAt || null,
    profiles: profileSummary,
  };
}

function loadSchedules() {
  if (!fs.existsSync(SCHEDULES_PATH)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(SCHEDULES_PATH, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveSchedules() {
  fs.writeFileSync(SCHEDULES_PATH, JSON.stringify(schedules, null, 2), "utf8");
}

function loadScheduleHistory() {
  if (!fs.existsSync(SCHEDULE_HISTORY_PATH)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(SCHEDULE_HISTORY_PATH, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveScheduleHistory() {
  fs.writeFileSync(SCHEDULE_HISTORY_PATH, JSON.stringify(scheduleHistory.slice(0, 100), null, 2), "utf8");
}

function addScheduleHistory(entry) {
  if (entry.status === "completed" && scheduleCompletionExists(entry)) return;
  scheduleHistory.unshift({
    time: new Date().toISOString(),
    ...entry,
  });
  scheduleHistory = scheduleHistory.slice(0, 100);
  saveScheduleHistory();
  sendEvent("schedule-history", scheduleHistory);
}

function dedupeScheduleHistory() {
  const seen = new Set();
  scheduleHistory = scheduleHistory.filter((item) => {
    if (item.status !== "completed") return true;
    const key = [
      item.status,
      item.name || "",
      path.resolve(item.chapters || ""),
      Number(item.maxChapter || 0),
    ].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  saveScheduleHistory();
}

function scheduleCompletionExists(entry) {
  return scheduleHistory.some((item) =>
    item.status === "completed"
    && item.name === entry.name
    && path.resolve(item.chapters || "") === path.resolve(entry.chapters || "")
    && Number(item.maxChapter || 0) === Number(entry.maxChapter || 0)
  );
}

function loadProjects() {
  if (!fs.existsSync(PROJECTS_PATH)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(PROJECTS_PATH, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveProjects() {
  fs.writeFileSync(PROJECTS_PATH, JSON.stringify(projects, null, 2), "utf8");
}

function projectSummary(project) {
  return {
    id: project.id,
    name: project.name,
    book: project.book || project.name || "",
    chapters: project.chapters || "",
    url: project.url || "",
    newUrl: project.newUrl || "",
    backendBook: project.backendBook || extractBackendBookFromUrl(project.url || ""),
    mode: project.mode || "upload-and-publish",
    minChars: Number(project.minChars || 1000),
    updatedAt: project.updatedAt || project.createdAt || null,
  };
}

function upsertProject(input = {}) {
  const chapters = input.chapters ? path.resolve(input.chapters) : "";
  const name = String(input.name || input.book || (chapters ? path.basename(path.dirname(chapters)) : "") || "未命名作品").trim();
  if (!chapters) throw new Error("项目档案需要章节目录。");
  const id = String(input.id || safeWorkName(`${name}_${chapters}`).slice(0, 120));
  const old = projects.find((item) => item.id === id || path.resolve(item.chapters || "") === chapters) || {};
  const next = {
    ...old,
    id: old.id || id,
    name,
    book: String(input.book || name).trim(),
    chapters,
    url: String(input.url || old.url || "").trim(),
    newUrl: String(input.newUrl || old.newUrl || "").trim(),
    backendBook: String(input.backendBook || old.backendBook || extractBackendBookFromUrl(input.url || old.url || "") || "").trim(),
    mode: input.mode || old.mode || "upload-and-publish",
    minChars: Number(input.minChars || old.minChars || 1000),
    createdAt: old.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  projects = projects.filter((item) => item.id !== next.id && path.resolve(item.chapters || "") !== chapters);
  projects.unshift(next);
  projects = projects.slice(0, 100);
  saveProjects();
  sendEvent("projects", projects.map(projectSummary));
  return projectSummary(next);
}

function deleteProject(id) {
  const before = projects.length;
  projects = projects.filter((item) => item.id !== id);
  saveProjects();
  sendEvent("projects", projects.map(projectSummary));
  return projects.length !== before;
}

function scheduleSummary(schedule) {
  return {
    id: schedule.id,
    name: schedule.name,
    chapters: schedule.chapters,
    book: schedule.book,
    intervalMinutes: schedule.intervalMinutes,
    batchSize: schedule.batchSize,
    maxChapter: schedule.maxChapter,
    mode: schedule.options?.mode || "publish-drafts",
    enabled: schedule.enabled,
    nextRunAt: schedule.nextRunAt,
    lastRunAt: schedule.lastRunAt || null,
    createdAt: schedule.createdAt,
  };
}

function getPublishedTo(chapters) {
  const item = summarizeProgress().find((entry) => path.resolve(entry.chapters) === path.resolve(chapters));
  return item?.publishedTo || 0;
}

function scheduleNextRun(schedule, from = Date.now()) {
  schedule.nextRunAt = new Date(from + schedule.intervalMinutes * 60 * 1000).toISOString();
}

function armSchedule(schedule) {
  if (scheduleTimers.has(schedule.id)) clearTimeout(scheduleTimers.get(schedule.id));
  if (!schedule.enabled) return;
  const delay = Math.max(1000, new Date(schedule.nextRunAt).getTime() - Date.now());
  const timer = setTimeout(() => runSchedule(schedule.id), delay);
  scheduleTimers.set(schedule.id, timer);
}

function armAllSchedules() {
  for (const timer of scheduleTimers.values()) clearTimeout(timer);
  scheduleTimers.clear();
  for (const schedule of schedules) armSchedule(schedule);
}

function createSchedule(options) {
  if (!options.chapters) throw new Error("定时任务需要章节目录。");
  const intervalMinutes = Number(options.intervalMinutes);
  if (![2, 30, 60, 120, 240].includes(intervalMinutes)) throw new Error("间隔只能是 2、30、60、120、240 分钟。");
  const mode = options.scheduleMode || options.mode || "publish-drafts";
  if (!["publish-drafts", "upload-and-publish"].includes(mode)) throw new Error("定时模式只能选择“发布草稿箱”或“上传并发布”。");
  const targetUrl = options.url || "";
  if (!targetUrl) throw new Error("定时任务需要填写作品后台 URL。");
  const batchSize = Math.max(1, Number(options.batchSize || 1));
  const maxChapter = Math.max(1, Number(options.maxChapter || options.end || 1));
  const preflight = buildPublishPreflight({ ...options, mode, url: targetUrl, end: maxChapter });
  if (!preflight.ok) throw new Error(`发布前预检未通过：${preflight.errors.join("；")}`);
  upsertProject({
    name: options.book || "",
    book: options.book || "",
    chapters: options.chapters,
    url: targetUrl,
    newUrl: options.newUrl || "",
    backendBook: options.backendBook || extractBackendBookFromUrl(targetUrl),
    mode,
    minChars: options.minChars || 1000,
  });
  const schedule = {
    id: Date.now().toString(),
    name: options.name || `${options.book || path.basename(path.dirname(options.chapters))} 定时发布`,
    chapters: path.resolve(options.chapters),
    book: options.book || "",
    intervalMinutes,
    batchSize,
    maxChapter,
    enabled: true,
    createdAt: new Date().toISOString(),
    lastRunAt: null,
    nextRunAt: "",
    options: {
      chapters: path.resolve(options.chapters),
      book: options.book || "",
      mode,
      url: targetUrl,
      confirmEach: false,
      confirmEvery: 0,
      minChars: Number(options.minChars || 1000),
      newUrl: options.newUrl || "",
      backendBook: options.backendBook || extractBackendBookFromUrl(targetUrl),
      reset: true,
      autoStart: true,
      noStrictQuality: Boolean(options.noStrictQuality),
    },
  };
  scheduleNextRun(schedule, Date.now());
  schedules.push(schedule);
  saveSchedules();
  armSchedule(schedule);
  sendEvent("schedules", schedules.map(scheduleSummary));
  return scheduleSummary(schedule);
}

function deleteSchedule(id) {
  const before = schedules.length;
  schedules = schedules.filter((schedule) => schedule.id !== id);
  if (scheduleTimers.has(id)) {
    clearTimeout(scheduleTimers.get(id));
    scheduleTimers.delete(id);
  }
  saveSchedules();
  sendEvent("schedules", schedules.map(scheduleSummary));
  return schedules.length !== before;
}

function removeSchedule(id) {
  schedules = schedules.filter((schedule) => schedule.id !== id);
  if (scheduleTimers.has(id)) {
    clearTimeout(scheduleTimers.get(id));
    scheduleTimers.delete(id);
  }
  saveSchedules();
  sendEvent("schedules", schedules.map(scheduleSummary));
}

function pruneCompletedSchedules({ silent = true } = {}) {
  let changed = false;
  for (const schedule of [...schedules]) {
    const publishedTo = getPublishedTo(schedule.chapters);
    if (publishedTo >= Number(schedule.maxChapter || 0)) {
      addScheduleHistory({
        name: schedule.name,
        chapters: schedule.chapters,
        book: schedule.book,
        mode: schedule.options?.mode || "publish-drafts",
        status: "completed",
        message: `已到截止章节 ${schedule.maxChapter}，自动删除`,
        maxChapter: schedule.maxChapter,
        publishedTo,
      });
      schedules = schedules.filter((item) => item.id !== schedule.id);
      if (scheduleTimers.has(schedule.id)) {
        clearTimeout(scheduleTimers.get(schedule.id));
        scheduleTimers.delete(schedule.id);
      }
      changed = true;
      if (!silent) appendLog(`定时任务 ${schedule.name} 已到截止章节 ${schedule.maxChapter}，自动删除。`);
    }
  }
  if (changed) {
    saveSchedules();
    sendEvent("schedules", schedules.map(scheduleSummary));
  }
}

function runSchedule(id) {
  const schedule = schedules.find((item) => item.id === id);
  if (!schedule || !schedule.enabled) return;
  try {
    if (currentJob?.process && !currentJob.exited) {
      appendLog(`定时任务 ${schedule.name} 跳过：当前已有任务运行。`);
    } else {
      const publishedTo = getPublishedTo(schedule.chapters);
      const start = publishedTo + 1;
      if (start > schedule.maxChapter) {
        if (!scheduleCompletionExists({
          name: schedule.name,
          chapters: schedule.chapters,
          maxChapter: schedule.maxChapter,
          status: "completed",
        })) {
          appendLog(`定时任务 ${schedule.name} 已到截止章节 ${schedule.maxChapter}，自动删除。`);
        }
        addScheduleHistory({
          name: schedule.name,
          chapters: schedule.chapters,
          book: schedule.book,
          mode: schedule.options?.mode || "publish-drafts",
          status: "completed",
          message: `已到截止章节 ${schedule.maxChapter}，自动删除`,
          maxChapter: schedule.maxChapter,
          publishedTo,
        });
        schedule.enabled = false;
        removeSchedule(schedule.id);
        return;
      } else {
        const end = Math.min(schedule.maxChapter, start + schedule.batchSize - 1);
        appendLog(`定时任务 ${schedule.name} 开始发布第 ${start}-${end} 章。`);
        addScheduleHistory({
          scheduleId: schedule.id,
          name: schedule.name,
          chapters: schedule.chapters,
          book: schedule.book,
          mode: schedule.options?.mode || "publish-drafts",
          status: "started",
          message: `开始处理第 ${start}-${end} 章`,
          start,
          end,
          maxChapter: schedule.maxChapter,
        });
        startJob({
          ...schedule.options,
          scheduleId: schedule.id,
          scheduleName: schedule.name,
          scheduleMaxChapter: schedule.maxChapter,
          start,
          end,
          reset: true,
        });
        schedule.lastRunAt = new Date().toISOString();
      }
    }
  } catch (error) {
    appendLog(`定时任务 ${schedule.name} 启动失败：${error.message || error}`);
  } finally {
    if (schedule.enabled && schedules.some((item) => item.id === schedule.id)) scheduleNextRun(schedule, Date.now());
    saveSchedules();
    if (schedules.some((item) => item.id === schedule.id)) armSchedule(schedule);
    sendEvent("schedules", schedules.map(scheduleSummary));
  }
}

function startJob(options) {
  if (currentJob?.process && !currentJob.exited) {
    throw new Error("已有任务正在运行，请先停止或等待完成。");
  }
  const preflight = buildPublishPreflight(options);
  if (!preflight.ok) {
    throw new Error(`发布前预检未通过：${preflight.errors.join("；")}`);
  }
  if (options.chapters) {
    upsertProject({
      name: options.book || "",
      book: options.book || "",
      chapters: options.chapters,
      url: options.url || "",
      newUrl: options.newUrl || "",
      backendBook: options.backendBook || extractBackendBookFromUrl(options.url || ""),
      mode: options.mode || "draft",
      minChars: options.minChars || 1000,
    });
  }
  const args = buildArgs(options);
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: false,
  });
  currentJob = {
    id: Date.now().toString(),
    args,
    options,
    scheduleId: options.scheduleId || null,
    scheduleName: options.scheduleName || "",
    scheduleMaxChapter: options.scheduleMaxChapter || null,
    process: child,
    startedAt: new Date().toISOString(),
    exited: false,
    exitCode: null,
    failureReason: "",
    pausedForManualReview: false,
  };
  appendLog(`启动任务：node ${args.join(" ")}`);
  child.stdout.on("data", (data) => {
    const text = data.toString();
    const reason = extractFailureReason(text);
    if (reason) currentJob.failureReason = reason;
    if (isManualPauseMessage(text)) currentJob.pausedForManualReview = true;
    appendLog(text);
  });
  child.stderr.on("data", (data) => {
    const text = data.toString();
    const reason = extractFailureReason(text);
    if (reason) currentJob.failureReason = reason;
    if (isManualPauseMessage(text)) currentJob.pausedForManualReview = true;
    appendLog(text);
  });
  child.on("exit", (code) => {
    currentJob.exited = true;
    currentJob.exitCode = code;
    appendLog(`任务结束，退出码：${code}`);
    if (code !== 0) {
      const reason = currentJob.failureReason || "脚本返回失败，但没有捕获到明确原因，请查看上方日志和失败截图。";
      currentJob.failureReason = reason;
      appendLog(`任务失败并已暂停：${reason}`);
    }
    finalizeScheduledJob(currentJob, code);
    sendEvent("status", getStatus());
    setTimeout(() => sendEvent("status", getStatus()), 1000);
  });
  sendEvent("status", getStatus());
}

function finalizeScheduledJob(job, code) {
  if (!job?.scheduleId) return;
  const schedule = schedules.find((item) => item.id === job.scheduleId);
  const progress = summarizeProgress().find((entry) => path.resolve(entry.chapters) === path.resolve(job.options.chapters));
  const publishedTo = progress?.publishedTo || 0;
  addScheduleHistory({
    scheduleId: job.scheduleId,
    name: job.scheduleName || schedule?.name || "定时发布",
    chapters: job.options.chapters,
    book: job.options.book || schedule?.book || "",
    mode: job.options.mode || schedule?.options?.mode || "publish-drafts",
    status: code === 0 ? "finished" : "failed",
    message: code === 0 ? `任务结束，当前已发布到第 ${publishedTo} 章` : `任务失败，已暂停：${job.failureReason || `退出码 ${code}`}`,
    start: job.options.start,
    end: job.options.end,
    maxChapter: job.scheduleMaxChapter || schedule?.maxChapter || null,
    publishedTo,
    exitCode: code,
  });
  if (schedule && code !== 0) {
    schedule.enabled = false;
    appendLog(`定时任务 ${schedule.name} 已因本次失败自动暂停，避免继续重复运行。`);
    saveSchedules();
  }
  if (schedule && code === 0 && publishedTo >= schedule.maxChapter) {
    if (!scheduleCompletionExists({
      name: schedule.name,
      chapters: schedule.chapters,
      maxChapter: schedule.maxChapter,
      status: "completed",
    })) {
      appendLog(`定时任务 ${schedule.name} 已完成截止章节 ${schedule.maxChapter}，自动删除。`);
    }
    addScheduleHistory({
      scheduleId: schedule.id,
      name: schedule.name,
      chapters: schedule.chapters,
      book: schedule.book,
      mode: schedule.options?.mode || "publish-drafts",
      status: "completed",
      message: `已完成截止章节 ${schedule.maxChapter}，自动删除`,
      maxChapter: schedule.maxChapter,
      publishedTo,
    });
    removeSchedule(schedule.id);
  }
}

function sendContinue() {
  if (!currentJob?.process || currentJob.exited) return false;
  currentJob.process.stdin.write("\n");
  appendLog("已发送继续信号。");
  return true;
}

function stopJob() {
  if (!currentJob?.process || currentJob.exited) return false;
  currentJob.process.kill();
  appendLog("已请求停止任务。");
  return true;
}

function safeWorkName(name) {
  return String(name || "").replace(/[\\/:*?"<>|]/g, "").trim() || "未命名小说";
}

function latestProjectDir(root, title) {
  if (!fs.existsSync(root)) return null;
  const base = safeWorkName(title);
  const candidates = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && (entry.name === base || entry.name.startsWith(`${base}_`)))
    .map((entry) => {
      const full = path.join(root, entry.name);
      return { full, mtime: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  return candidates[0]?.full || null;
}

function ensureWritableDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.accessSync(dir, fs.constants.W_OK);
}

function getStudioHealth() {
  const ai = resolveStudioAiConfig();
  const issues = [];
  const warnings = [];
  const ok = [];

  if (!fs.existsSync(path.join(ROOT, "fanqie-publisher.js"))) issues.push("缺少发布脚本 fanqie-publisher.js");
  else ok.push("发布脚本可用");

  if (!fs.existsSync(path.join(ROOT, "scripts", "studio-generator.js"))) issues.push("缺少作品生成脚本 scripts/studio-generator.js");
  else ok.push("生成脚本可用");

  try {
    ensureWritableDir(STUDIO_OUTPUT_ROOT);
    ok.push("生成目录可写");
  } catch (error) {
    issues.push(`生成目录不可写：${error.message || error}`);
  }

  if (!ai.model) issues.push("AI模型名未配置");
  if (ai.provider !== "local" && !ai.apiKey) issues.push("云端模型缺少 API Key");
  if (ai.provider === "local" && !ai.baseUrl) issues.push("本地模型地址未配置");
  if (ai.provider === "local") warnings.push("当前使用本地备用模型，正式长篇生成质量可能不稳定");
  if (studioJob?.process && !studioJob.exited) warnings.push("作品生成任务正在运行");
  if (currentJob?.process && !currentJob.exited) warnings.push("发布任务正在运行");

  const generated = listGeneratedWorks();
  if (!generated.length) warnings.push("作品库里还没有生成作品");
  else ok.push(`作品库已发现 ${generated.length} 个项目`);

  return {
    ready: issues.length === 0,
    issues,
    warnings,
    ok,
    checkedAt: new Date().toISOString(),
  };
}

function validateStudioGenerationOptions(options) {
  const health = getStudioHealth();
  const engine = options.engine === "template" ? "template" : "ai";
  const action = options.action === "batch" ? "batch" : "project";
  const title = String(options.title || "").trim();
  const minWords = Number(options.minWords || options.words || 1050);
  const maxWords = Number(options.maxWords || 1300);
  const chapters = Number(options.chapters || 0);
  const batchSize = Number(options.batchSize || 0);

  if (!title) throw new Error("请先填写书名。");
  if (!Number.isFinite(chapters) || chapters < 1 || chapters > 2000) throw new Error("规划章节数必须在 1-2000 之间。");
  if (!Number.isFinite(minWords) || !Number.isFinite(maxWords) || minWords < 600 || maxWords > 5000 || minWords > maxWords) {
    throw new Error("每章字数区间必须在 600-5000 之间，且最低字数不能大于最高字数。");
  }
  if (!Number.isFinite(batchSize) || batchSize < 1 || batchSize > 200) throw new Error("续写批量必须在 1-200 章之间。");
  if (engine === "ai" && health.issues.length) throw new Error(`启动前自检未通过：${health.issues.join("；")}`);
  if (action === "batch") {
    const projectDir = latestProjectDir(STUDIO_OUTPUT_ROOT, title);
    if (!projectDir) throw new Error(`没有找到《${title}》项目包，请先生成项目包。`);
  }
}

function startStudioGeneration(options) {
  if (studioJob?.process && !studioJob.exited) {
    throw new Error("已有作品生成任务正在运行，请先等待完成。");
  }
  validateStudioGenerationOptions(options);
  const ai = resolveStudioAiConfig(options);
  const args = buildStudioGenerateArgs(options);
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: {
      ...process.env,
      AI_API_KEY: ai.apiKey,
      AI_BASE_URL: ai.baseUrl,
      AI_MODEL: ai.model,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  studioJob = {
    id: Date.now().toString(),
    args,
    options,
    process: child,
    startedAt: new Date().toISOString(),
    exited: false,
    exitCode: null,
  };
  appendLog(`启动作品生成：《${options.title || "未命名小说"}》，${options.action === "batch" ? "续写" : "项目包"}，批量 ${Math.max(1, Math.min(200, Number(options.batchSize || 10)))} 章。`);
  appendLog(`启动作品生成命令：node ${args.join(" ")}`);
  child.stdout.on("data", (data) => appendLog(data.toString()));
  child.stderr.on("data", (data) => appendLog(data.toString()));
  child.on("exit", (code) => {
    studioJob.exited = true;
    studioJob.exitCode = code;
    appendLog(`作品生成结束，退出码：${code}`);
    sendEvent("status", getStatus());
  });
  sendEvent("status", getStatus());
}

function stopStudioGeneration() {
  if (!studioJob?.process || studioJob.exited) return false;
  studioJob.process.kill();
  appendLog("已请求停止作品生成任务。");
  return true;
}

function readRunStates() {
  if (!fs.existsSync(RUNS_DIR)) return [];
  const files = fs.readdirSync(RUNS_DIR).filter((name) => name.endsWith(".json"));
  const states = [];
  for (const file of files) {
    try {
      const full = path.join(RUNS_DIR, file);
      const data = JSON.parse(fs.readFileSync(full, "utf8"));
      states.push({ ...data, file, mtime: fs.statSync(full).mtimeMs });
    } catch {}
  }
  return states.sort((a, b) => b.mtime - a.mtime);
}

function summarizeProgress() {
  const states = readRunStates();
  const summary = {};
  for (const state of states) {
    const key = state.chapters || "unknown";
    if (!summary[key]) {
      summary[key] = {
        chapters: key,
        uploadedTo: 0,
        publishedTo: 0,
        latestUploadRun: null,
        latestPublishRun: null,
      };
    }
    const completed = Array.isArray(state.completed) ? state.completed : [];
    const max = completed.length ? Math.max(...completed) : 0;
    if ((state.mode === "draft" || state.mode === "upload-and-publish") && max > summary[key].uploadedTo) {
      summary[key].uploadedTo = max;
      summary[key].latestUploadRun = state;
    }
    if ((state.mode === "publish-drafts" || state.mode === "upload-and-publish") && max > summary[key].publishedTo) {
      summary[key].publishedTo = max;
      summary[key].latestPublishRun = state;
    }
  }
  return Object.values(summary);
}

function readJsonSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function listChapterFiles(chaptersDir) {
  const files = [];
  if (!fs.existsSync(chaptersDir)) return files;
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".txt")) {
        const match = entry.name.match(/^(\d+)/);
        if (match) {
          const stat = fs.statSync(fullPath);
          files.push({
            path: fullPath,
            name: entry.name,
            number: Number(match[1]),
            mtimeMs: stat.mtimeMs,
          });
        }
      }
    }
  };
  visit(chaptersDir);
  return files.sort((a, b) => a.number - b.number || a.name.localeCompare(b.name));
}

function listTxtFilesForFix(dir) {
  const files = [];
  if (!fs.existsSync(dir)) return files;
  const walk = (current) => {
    for (const item of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, item.name);
      if (item.isDirectory()) walk(full);
      else if (item.isFile() && item.name.endsWith(".txt")) files.push(full);
    }
  };
  walk(dir);
  return files.sort((a, b) => {
    const an = Number(path.basename(a).match(/^(\d+)/)?.[1] || 0);
    const bn = Number(path.basename(b).match(/^(\d+)/)?.[1] || 0);
    return an - bn || a.localeCompare(b);
  });
}

function fixHeadingLine(line) {
  let fixed = String(line || "").replace(/^\uFEFF/, "").trim();
  const changes = [];
  const chapterPattern = "第\\s*([0-9０-９零〇一二两三四五六七八九十百千万]+)\\s*章";
  const duplicateNo = new RegExp(`^(${chapterPattern})[\\s:：、.\\-]+${chapterPattern}[\\s:：、.\\-]*(.*)$`);
  const sameNo = fixed.match(duplicateNo);
  if (sameNo && sameNo[2] === sameNo[3]) {
    fixed = `${sameNo[1].replace(/\s+/g, "")} ${sameNo[4].trim()}`.trim();
    changes.push("删除重复章号");
  }

  const duplicateChineseChapter = fixed.match(/^(第[一二三四五六七八九十百千万零〇两]+章)[\s:：、.\-]+\1[\s:：、.\-]*(.*)$/);
  if (duplicateChineseChapter) {
    fixed = `${duplicateChineseChapter[1]} ${duplicateChineseChapter[2].trim()}`.trim();
    changes.push("删除重复中文章号");
  }

  fixed = fixed.replace(/\s{2,}/g, " ").trim();
  return { fixed, changes };
}

function fixChapterTextFormat(raw) {
  const original = String(raw || "").replace(/^\uFEFF/, "");
  const lines = original.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  let leadingBlankCount = 0;
  while (lines.length && !lines[0].trim()) {
    lines.shift();
    leadingBlankCount++;
  }
  if (!lines.length) return { text: original, changes: [] };

  const result = fixHeadingLine(lines[0]);
  lines[0] = result.fixed;
  const changes = [...result.changes];
  if (leadingBlankCount) changes.push("删除开头空行");

  const text = lines.join("\r\n").replace(/\s+$/g, "") + "\r\n";
  return { text, changes };
}

function fixChapterFormats(options = {}) {
  const chaptersDir = path.resolve(options.chapters || MAIN_CHAPTERS_DIR);
  if (!fs.existsSync(chaptersDir)) throw new Error(`章节目录不存在：${chaptersDir}`);
  const start = Number(options.start || 1);
  const end = Number(options.end || Infinity);
  const changed = [];
  const scanned = [];

  for (const file of listTxtFilesForFix(chaptersDir)) {
    const no = Number(path.basename(file).match(/^(\d+)/)?.[1] || 0);
    if (!no || no < start || no > end) continue;
    scanned.push(no);
    const raw = fs.readFileSync(file, "utf8");
    const result = fixChapterTextFormat(raw);
    if (result.changes.length && result.text !== raw) {
      fs.writeFileSync(file, result.text, "utf8");
      changed.push({ no, file, changes: result.changes });
    }
  }

  appendLog(`格式修复完成：扫描 ${scanned.length} 章，修复 ${changed.length} 章。`);
  for (const item of changed.slice(0, 30)) {
    appendLog(`第 ${item.no} 章：${item.changes.join("、")}`);
  }
  if (changed.length > 30) appendLog(`还有 ${changed.length - 30} 章已修复，日志省略。`);
  return { ok: true, chapters: chaptersDir, scanned: scanned.length, changed };
}

function pureTextCount(text) {
  return Array.from(String(text || "").replace(/[^\p{L}\p{N}]/gu, "")).length;
}

function platformCharCount(text) {
  return (String(text || "").match(/\p{Script=Han}/gu) || []).length;
}

function chapterNoFromFile(file) {
  return Number(path.basename(file).match(/^(\d+)/)?.[1] || 0);
}

function buildPublishPreflight(options = {}) {
  const errors = [];
  const warnings = [];
  const mode = options.mode || "draft";
  const backendBook = options.backendBook || extractBackendBookFromUrl(options.url || "");
  const chaptersDir = options.chapters ? path.resolve(options.chapters) : "";
  const start = Math.max(1, Number(options.start || 1));
  const end = Math.max(start, Number(options.end || start));
  const minChars = Math.max(1, Number(options.minChars || 1000));

  if (!chaptersDir) errors.push("未填写章节目录。");
  else if (!fs.existsSync(chaptersDir)) errors.push(`章节目录不存在：${chaptersDir}`);

  if (!["draft", "publish-drafts", "dry-run", "upload-and-publish"].includes(mode)) {
    errors.push("发布工作台只支持：上传草稿、发布草稿箱、本地检查、直接发布。");
  }
  if (["publish-drafts", "upload-and-publish"].includes(mode) && !String(options.url || "").trim()) {
    errors.push("发布任务需要填写作品后台 URL。");
  }
  if (!String(options.book || "").trim()) warnings.push("未填写本地书名，日志会从章节目录推断。");
  if (backendBook && options.book && backendBook !== options.book) {
    warnings.push(`本地书名《${options.book}》与后台作品《${backendBook}》不同；自动点击将按后台作品匹配。`);
  }

  const found = [];
  const missing = [];
  const low = [];
  const duplicate = [];
  const seen = new Set();

  if (chaptersDir && fs.existsSync(chaptersDir)) {
    const files = listTxtFilesForFix(chaptersDir);
    for (const file of files) {
      const no = chapterNoFromFile(file);
      if (!no || no < start || no > end) continue;
      if (seen.has(no)) duplicate.push(no);
      seen.add(no);
      const raw = fs.readFileSync(file, "utf8");
      const body = raw.replace(/^\uFEFF/, "").split(/\r?\n/).slice(1).join("\n").trim() || raw;
      const chars = platformCharCount(body);
      const pureChars = pureTextCount(body);
      found.push({ no, file, chars, pureChars });
      if (chars < minChars) low.push({ no, chars, pureChars, file });
    }
    for (let no = start; no <= end; no++) {
      if (!seen.has(no)) missing.push(no);
    }
  }

  if (!found.length && chaptersDir && fs.existsSync(chaptersDir)) errors.push(`第 ${start}-${end} 章没有找到可发布章节。`);
  if (missing.length) errors.push(`缺失章节：${missing.join("、")}`);
  if (duplicate.length) errors.push(`章节号重复：${Array.from(new Set(duplicate)).join("、")}`);
  if (low.length) {
    const preview = low.slice(0, 12).map((item) => `第${item.no}章 ${item.chars}/${minChars}字`).join("；");
    errors.push(`字数不足：${preview}${low.length > 12 ? `；另有 ${low.length - 12} 章` : ""}`);
  }

  const result = {
    ok: errors.length === 0,
    errors,
    warnings,
    chapters: chaptersDir,
    mode,
    backendBook,
    start,
    end,
    minChars,
    scanned: found.length,
    missing,
    low,
    duplicate: Array.from(new Set(duplicate)),
  };
  appendLog(result.ok
    ? `发布前预检通过：第 ${start}-${end} 章，扫描 ${found.length} 章。`
    : `发布前预检失败：${errors.join("；")}`);
  for (const warning of warnings) appendLog(`发布前预检提醒：${warning}`);
  return result;
}

function browserExecutable() {
  return CHROME_PATHS.find((item) => item && fs.existsSync(item))
    || EDGE_PATHS.find((item) => fs.existsSync(item))
    || "";
}

async function testBackendUrl(options = {}) {
  const targetUrl = String(options.url || "").trim();
  const book = String(options.backendBook || options.book || extractBackendBookFromUrl(targetUrl) || "").trim();
  if (!targetUrl) throw new Error("请先填写作品后台 URL。");
  if (!/^https:\/\/fanqienovel\.com\//.test(targetUrl)) {
    throw new Error("作品后台 URL 必须是 fanqienovel.com 地址。");
  }

  const executablePath = browserExecutable();
  const launchOptions = {
    headless: true,
    viewport: { width: 1365, height: 900 },
  };
  if (executablePath) launchOptions.executablePath = executablePath;

  const context = await chromium.launchPersistentContext(BROWSER_PROFILE_DIR, launchOptions);
  try {
    const page = context.pages()[0] || await context.newPage();
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(5000);
    const data = await page.evaluate((expectedBook) => {
      const text = document.body?.innerText || "";
      const clean = text.replace(/\s+/g, "");
      const newChapterButtons = Array.from(document.querySelectorAll("button,a,[role='button'],.arco-btn,.semi-button,span"))
        .filter((node) => /新建章节|添加章节|写新章节|创建章节/.test(node.textContent || "")).length;
      return {
        title: document.title,
        url: location.href,
        loggedIn: !/登录|扫码登录|验证码登录/.test(clean) || /作家专区|工作台|作品管理/.test(clean),
        hasBook: expectedBook ? clean.includes(expectedBook.replace(/\s+/g, "")) : true,
        hasChapterManage: /章节管理|草稿箱|章节名称|审核状态/.test(clean),
        hasNewChapter: newChapterButtons > 0 || /新建章节/.test(clean),
        newChapterButtons,
        textStart: text.slice(0, 300),
      };
    }, book);
    const errors = [];
    const warnings = [];
    if (!data.loggedIn) errors.push("当前浏览器未登录番茄作家后台。");
    if (book && !data.hasBook) errors.push(`页面未检测到书名《${book}》。`);
    if (!data.hasChapterManage) errors.push("页面未检测到章节管理/草稿箱信息。");
    if (!data.hasNewChapter) warnings.push("页面未检测到“新建章节”入口，上传并发布可能无法自动新建章节。");
    const result = {
      ok: errors.length === 0,
      errors,
      warnings,
      ...data,
      checkedAt: new Date().toISOString(),
      backendBook: book,
    };
    appendLog(result.ok
      ? `后台 URL 测试通过：${book || targetUrl}`
      : `后台 URL 测试失败：${errors.join("；")}`);
    for (const warning of warnings) appendLog(`后台 URL 测试提醒：${warning}`);
    return result;
  } finally {
    await context.close().catch(() => {});
  }
}

function checkChapterWordCounts(options = {}) {
  const chaptersDir = path.resolve(options.chapters || MAIN_CHAPTERS_DIR);
  if (!fs.existsSync(chaptersDir)) throw new Error(`章节目录不存在：${chaptersDir}`);
  const start = Number(options.start || 1);
  const end = Number(options.end || Infinity);
  const minPureChars = Number(options.minPureChars || 1020);
  const results = [];
  const failed = [];

  for (const file of listTxtFilesForFix(chaptersDir)) {
    const no = Number(path.basename(file).match(/^(\d+)/)?.[1] || 0);
    if (!no || no < start || no > end) continue;
    const raw = fs.readFileSync(file, "utf8");
    const lines = raw.replace(/^\uFEFF/, "").split(/\r?\n/);
    const body = lines.slice(1).join("\n").trim();
    const count = pureTextCount(body || raw);
    const item = { no, file, pureChars: count, ok: count >= minPureChars };
    results.push(item);
    if (!item.ok) failed.push(item);
  }

  if (!results.length) {
    appendLog(`字数检查：第 ${start}-${Number.isFinite(end) ? end : "末"} 章没有找到可检查章节。`);
    return { ok: false, chapters: chaptersDir, minPureChars, scanned: 0, failed: [], results: [] };
  }

  const counts = results.map((item) => item.pureChars);
  appendLog(`字数检查完成：第 ${start}-${Number.isFinite(end) ? end : results.at(-1).no} 章，扫描 ${results.length} 章，要求纯文字 > ${minPureChars} 字。`);
  appendLog(`字数检查结果：最短 ${Math.min(...counts)} 字，最长 ${Math.max(...counts)} 字，不达标 ${failed.length} 章。`);
  for (const item of failed.slice(0, 50)) {
    appendLog(`第 ${item.no} 章不达标：纯文字 ${item.pureChars} 字，需大于 ${minPureChars} 字。`);
  }
  if (failed.length > 50) appendLog(`还有 ${failed.length - 50} 章不达标，日志省略。`);
  return { ok: failed.length === 0, chapters: chaptersDir, minPureChars, scanned: results.length, failed, results };
}

function chapterSummary(chaptersDir) {
  const files = listChapterFiles(chaptersDir);
  const latest = files.length ? files[files.length - 1] : null;
  const numbers = files.map((file) => file.number).filter(Boolean);
  const uniqueNumbers = new Set(numbers);
  const duplicateCount = Math.max(0, numbers.length - uniqueNumbers.size);
  return {
    chaptersPath: chaptersDir,
    count: files.length,
    uniqueCount: uniqueNumbers.size,
    duplicateCount,
    latestChapter: latest?.number || 0,
    updatedAt: latest ? new Date(latest.mtimeMs).toISOString() : null,
  };
}

function nextChapterRange(latestChapter, batchSize = 10) {
  const start = latestChapter + 1;
  const end = latestChapter + batchSize;
  return `${start}-${end}`;
}

function listGeneratedWorks() {
  if (!fs.existsSync(STUDIO_OUTPUT_ROOT)) return [];
  return fs.readdirSync(STUDIO_OUTPUT_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const workDir = path.join(STUDIO_OUTPUT_ROOT, entry.name);
      const chaptersDir = path.join(workDir, "chapters");
      const chapters = chapterSummary(chaptersDir);
      const state = readJsonSafe(path.join(workDir, "generation_state.json")) || {};
      const stat = fs.statSync(workDir);
      return {
        name: state.title || entry.name,
        chapters: chapters.latestChapter,
        fileCount: chapters.count,
        duplicateCount: chapters.duplicateCount,
        latestChapter: chapters.latestChapter,
        status: state.status || (chapters.latestChapter ? `正文已到第 ${chapters.latestChapter} 章${chapters.duplicateCount ? `；重复文件 ${chapters.duplicateCount} 个` : ""}` : "待生成"),
        next: chapters.count ? "质检 / 改写 / 发布包" : "继续生成章节",
        engine: state.engine || "",
        model: state.model || "",
        path: workDir,
        chaptersPath: chaptersDir,
        updatedAt: chapters.updatedAt || new Date(stat.mtimeMs).toISOString(),
      };
    })
    .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
}

function librarySummary() {
  if (!fs.existsSync(LIBRARY_DIR)) return null;
  const works = fs.readdirSync(LIBRARY_DIR, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  let totalChapters = 0;
  for (const work of works) {
    const direct = path.join(LIBRARY_DIR, work.name, "chapters");
    const fallback = path.join(LIBRARY_DIR, work.name);
    totalChapters += chapterSummary(fs.existsSync(direct) ? direct : fallback).count;
  }
  return {
    name: "十部长篇玄幻",
    works: works.length,
    chapters: totalChapters,
    status: "素材库",
    next: "筛选可重写作品",
  };
}

function getStudioOverview() {
  const main = chapterSummary(MAIN_CHAPTERS_DIR);
  const progress = summarizeProgress();
  const mainProgress = progress.find((entry) => path.resolve(entry.chapters) === path.resolve(MAIN_CHAPTERS_DIR));
  const library = librarySummary();
  const rows = [{
    name: "苍生印_重写版",
    chapters: main.latestChapter,
    fileCount: main.count,
    duplicateCount: main.duplicateCount,
    latestChapter: main.latestChapter,
    status: main.latestChapter ? `正文已到第 ${main.latestChapter} 章${main.duplicateCount ? `；重复文件 ${main.duplicateCount} 个` : ""}` : "未发现正文",
    next: main.count ? `补齐 / 检查 ${nextChapterRange(main.latestChapter)}` : "先生成正文",
    path: MAIN_NOVEL_DIR,
    chaptersPath: MAIN_CHAPTERS_DIR,
    uploadedTo: mainProgress?.uploadedTo || 0,
    publishedTo: mainProgress?.publishedTo || 0,
    updatedAt: main.updatedAt,
  }];
  if (library) rows.push(library);
  rows.push(...listGeneratedWorks());

  return {
    updatedAt: new Date().toISOString(),
    mainProject: rows[0],
    generatedWorks: rows.slice(library ? 2 : 1),
    library,
    rows,
    pipeline: [
      ["立项", "卖点、类型、目标读者"],
      ["总设定", "世界观、人物、长线伏笔"],
      ["章纲", "每 10 章功能、冲突、反转"],
      ["正文", "批量生成或重写"],
      ["质检", "缺章、低字数、重复、设定冲突"],
      ["发布包", "首章、试读、简介、合并稿"],
      ["草稿", "小批量上传，后台确认"],
      ["定时", "按批次发布并复盘"],
    ],
  };
}

function getStatus() {
  const ai = resolveStudioAiConfig();
  return {
    running: Boolean(currentJob?.process && !currentJob.exited),
    job: currentJob ? {
      id: currentJob.id,
      args: currentJob.args,
      options: currentJob.options,
      startedAt: currentJob.startedAt,
      exited: currentJob.exited,
      exitCode: currentJob.exitCode,
      failureReason: currentJob.failureReason || "",
      pausedForManualReview: Boolean(currentJob.pausedForManualReview),
    } : null,
    studioJob: studioJob ? {
      id: studioJob.id,
      args: studioJob.args,
      options: studioJob.options,
      startedAt: studioJob.startedAt,
      exited: studioJob.exited,
      exitCode: studioJob.exitCode,
    } : null,
    studioRunning: Boolean(studioJob?.process && !studioJob.exited),
    studioOutputRoot: STUDIO_OUTPUT_ROOT,
    aiConfig: publicStudioAiConfig(ai),
    health: getStudioHealth(),
    projects: projects.map(projectSummary),
    progress: summarizeProgress(),
    schedules: schedules.map(scheduleSummary),
    scheduleHistory,
    logs: memoryLogs.slice(-200),
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      clients.add(res);
      res.write(`event: status\ndata: ${JSON.stringify(getStatus())}\n\n`);
      res.write(`event: schedule-history\ndata: ${JSON.stringify(scheduleHistory)}\n\n`);
      req.on("close", () => clients.delete(res));
      return;
    }
    if (url.pathname === "/api/status") return json(res, 200, getStatus());
    if (url.pathname === "/api/preflight" && req.method === "POST") {
      const body = await readBody(req);
      return json(res, 200, buildPublishPreflight(body));
    }
    if (url.pathname === "/api/test-backend-url" && req.method === "POST") {
      const body = await readBody(req);
      return json(res, 200, await testBackendUrl(body));
    }
    if (url.pathname === "/api/projects" && req.method === "POST") {
      const body = await readBody(req);
      return json(res, 200, { project: upsertProject(body), projects: projects.map(projectSummary) });
    }
    if (url.pathname === "/api/projects") return json(res, 200, projects.map(projectSummary));
    if (url.pathname === "/api/studio/overview") return json(res, 200, getStudioOverview());
    if (url.pathname === "/api/studio/health") return json(res, 200, getStudioHealth());
    if (url.pathname === "/api/studio/ai-config" && req.method === "GET") {
      return json(res, 200, publicStudioAiConfig());
    }
    if (url.pathname === "/api/studio/ai-config" && req.method === "POST") {
      const body = await readBody(req);
      return json(res, 200, saveStudioAiConfig(body));
    }
    if (url.pathname === "/api/start" && req.method === "POST") {
      const body = await readBody(req);
      startJob(body);
      return json(res, 200, getStatus());
    }
    if (url.pathname === "/api/continue" && req.method === "POST") {
      return json(res, 200, { ok: sendContinue(), status: getStatus() });
    }
    if (url.pathname === "/api/stop" && req.method === "POST") {
      return json(res, 200, { ok: stopJob(), status: getStatus() });
    }
    if (url.pathname === "/api/studio/generate" && req.method === "POST") {
      const body = await readBody(req);
      startStudioGeneration(body);
      return json(res, 200, getStatus());
    }
    if (url.pathname === "/api/studio/stop" && req.method === "POST") {
      return json(res, 200, { ok: stopStudioGeneration(), status: getStatus() });
    }
    if (url.pathname === "/api/studio/fix-format" && req.method === "POST") {
      const body = await readBody(req);
      return json(res, 200, { ...fixChapterFormats(body), status: getStatus() });
    }
    if (url.pathname === "/api/studio/check-words" && req.method === "POST") {
      const body = await readBody(req);
      return json(res, 200, { ...checkChapterWordCounts(body), status: getStatus() });
    }
    if (url.pathname === "/api/schedules" && req.method === "POST") {
      const body = await readBody(req);
      return json(res, 200, createSchedule(body));
    }
    if (url.pathname === "/api/schedules") return json(res, 200, schedules.map(scheduleSummary));
    if (url.pathname === "/api/schedule-history") return json(res, 200, scheduleHistory);
    if (url.pathname === "/api/progress") return json(res, 200, summarizeProgress());
    if (url.pathname.startsWith("/api/schedules/") && req.method === "DELETE") {
      const id = decodeURIComponent(url.pathname.split("/").at(-1));
      return json(res, 200, { ok: deleteSchedule(id), schedules: schedules.map(scheduleSummary) });
    }
    if (url.pathname.startsWith("/api/projects/") && req.method === "DELETE") {
      const id = decodeURIComponent(url.pathname.split("/").at(-1));
      return json(res, 200, { ok: deleteProject(id), projects: projects.map(projectSummary) });
    }

    const requested = url.pathname === "/" ? "/index.html" : url.pathname;
    const filePath = safeFile(path.join(PUBLIC_DIR, requested));
    if (!filePath || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      return json(res, 404, { error: "Not found" });
    }
    res.writeHead(200, { "Content-Type": contentType(filePath) });
    fs.createReadStream(filePath).pipe(res);
  } catch (error) {
    json(res, 500, { error: error.message || String(error) });
  }
});

server.listen(PORT, () => {
  console.log(`Fanqie Publisher Web UI: http://localhost:${PORT}`);
});

dedupeScheduleHistory();
pruneCompletedSchedules({ silent: true });
armAllSchedules();
