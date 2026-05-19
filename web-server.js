const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = process.cwd();
const PUBLIC_DIR = path.join(ROOT, "public");
const RUNS_DIR = path.join(ROOT, ".fanqie-runs");
const PORT = Number(process.env.PORT || 3899);

let currentJob = null;
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
  return args;
}

function startJob(options) {
  if (currentJob?.process && !currentJob.exited) {
    throw new Error("已有任务正在运行，请先停止或等待完成。");
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
    process: child,
    startedAt: new Date().toISOString(),
    exited: false,
    exitCode: null,
  };
  appendLog(`启动任务：node ${args.join(" ")}`);
  child.stdout.on("data", (data) => appendLog(data.toString()));
  child.stderr.on("data", (data) => appendLog(data.toString()));
  child.on("exit", (code) => {
    currentJob.exited = true;
    currentJob.exitCode = code;
    appendLog(`任务结束，退出码：${code}`);
    sendEvent("status", getStatus());
  });
  sendEvent("status", getStatus());
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

function getStatus() {
  return {
    running: Boolean(currentJob?.process && !currentJob.exited),
    job: currentJob ? {
      id: currentJob.id,
      args: currentJob.args,
      options: currentJob.options,
      startedAt: currentJob.startedAt,
      exited: currentJob.exited,
      exitCode: currentJob.exitCode,
    } : null,
    progress: summarizeProgress(),
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
      req.on("close", () => clients.delete(res));
      return;
    }
    if (url.pathname === "/api/status") return json(res, 200, getStatus());
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
    if (url.pathname === "/api/progress") return json(res, 200, summarizeProgress());

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
