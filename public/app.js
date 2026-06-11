const $ = (id) => document.getElementById(id);

const logs = $("logs");
const progress = $("progress");
const jobInfo = $("jobInfo");
const jobState = $("jobState");
const schedules = $("schedules");
const scheduleHistory = $("scheduleHistory");
const historyToggle = $("historyToggle");
const historyPanel = $("historyPanel");
const failureModal = $("failureModal");
const failureMessage = $("failureMessage");
const failureClose = $("failureClose");
const failureOk = $("failureOk");
const projectSelect = $("projectSelect");
const preflightResult = $("preflightResult");
const urlTestResult = $("urlTestResult");
let historyOpen = false;
let lastFailureJobId = "";
let projectItems = [];

function appendLog(entry) {
  const text = typeof entry === "string" ? entry : `[${entry.time}] ${entry.message}`;
  logs.textContent += text.endsWith("\n") ? text : `${text}\n`;
  logs.scrollTop = logs.scrollHeight;
}

function renderProgress(items = []) {
  if (!items.length) {
    progress.innerHTML = "<p>暂无进度记录</p>";
    return;
  }
  progress.innerHTML = items.map((item) => `
    <div class="progress-item">
      <div class="progress-title">${escapeHtml(item.chapters)}</div>
      <div class="metrics">
        <div class="metric">草稿上传到：<strong>${item.uploadedTo || 0}</strong> 章</div>
        <div class="metric">已发布到：<strong>${item.publishedTo || 0}</strong> 章</div>
      </div>
    </div>
  `).join("");
}

function renderStatus(status) {
  const paused = Boolean(status.running && status.job?.pausedForManualReview);
  jobState.textContent = paused ? "待人工处理" : (status.running ? "运行中" : "空闲");
  jobState.className = `state ${paused ? "paused" : (status.running ? "running" : "idle")}`;
  jobInfo.textContent = status.job ? JSON.stringify(status.job, null, 2) : "暂无任务";
  renderProgress(status.progress || []);
  renderSchedules(status.schedules || []);
  renderScheduleHistory(status.scheduleHistory || []);
  renderProjects(status.projects || []);
  maybeShowFailure(status);
}

function renderProjects(items = []) {
  projectItems = items;
  const current = projectSelect.value;
  projectSelect.innerHTML = `<option value="">不使用档案</option>` + items.map((item) => `
    <option value="${escapeHtml(item.id)}">${escapeHtml(item.name || item.book || "未命名作品")}</option>
  `).join("");
  if (items.some((item) => item.id === current)) {
    projectSelect.value = current;
    return;
  }
  if ($("chapters").value.trim()) return;
  const defaultProject = items.find((item) => item.url || item.backendBook)
    || items.find((item) => String(item.chapters || "").includes("苍生印_重写版"))
    || items[0];
  if (!defaultProject) return;
  projectSelect.value = defaultProject.id;
  applyProject(defaultProject);
}

function applyProject(project) {
  if (!project) return;
  $("chapters").value = project.chapters || "";
  $("book").value = project.book || project.name || "";
  $("mode").value = project.mode || "upload-and-publish";
  $("minChars").value = project.minChars || 1000;
  $("targetUrl").value = project.url || "";
  $("newUrl").value = project.newUrl || "";
}

function showFailure(message) {
  failureMessage.textContent = message || "任务失败，已暂停。";
  failureModal.classList.remove("hidden");
}

function hideFailure() {
  failureModal.classList.add("hidden");
}

function maybeShowFailure(status) {
  const job = status.job;
  if (!job || !job.exited || Number(job.exitCode) === 0) return;
  if (lastFailureJobId === job.id) return;
  lastFailureJobId = job.id;
  const reason = job.failureReason || `退出码 ${job.exitCode}`;
  showFailure(`任务失败，已暂停。原因：${reason}`);
}

function renderSchedules(items = []) {
  if (!items.length) {
    schedules.innerHTML = "<p>暂无定时任务</p>";
    return;
  }
  schedules.innerHTML = items.map((item) => {
    const modeText = item.mode === "upload-and-publish" ? "上传并发布" : "发布草稿箱";
    return `
    <div class="schedule-item">
      <div>
        <div class="schedule-main">${escapeHtml(item.name || "定时发布")}</div>
        <div class="schedule-meta">
          ${modeText}；每 ${item.intervalMinutes} 分钟发布 ${item.batchSize} 章，截止第 ${item.maxChapter} 章；
          下次：${item.nextRunAt ? new Date(item.nextRunAt).toLocaleString() : "-"}
        </div>
      </div>
      <button data-delete-schedule="${item.id}" class="danger">删除</button>
    </div>
  `; }).join("");
}

function renderScheduleHistory(items = []) {
  if (!items.length) {
    scheduleHistory.innerHTML = "<p>暂无定时任务历史</p>";
    return;
  }
  scheduleHistory.innerHTML = items.slice(0, 20).map((item) => {
    const modeText = item.mode === "upload-and-publish" ? "上传并发布" : "发布草稿箱";
    const range = item.start ? `第 ${item.start}-${item.end} 章；` : "";
    const statusText = {
      started: "开始",
      finished: "结束",
      failed: "失败",
      completed: "完成",
    }[item.status] || item.status || "-";
    return `
      <div class="history-item">
        <div>
          <div class="schedule-main">${escapeHtml(item.name || "定时发布")} <span class="tag">${escapeHtml(statusText)}</span></div>
          <div class="schedule-meta">
            ${new Date(item.time).toLocaleString()}；${modeText}；${range}${escapeHtml(item.message || "")}
          </div>
        </div>
      </div>
    `;
  }).join("");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function payload() {
  const data = {
    chapters: $("chapters").value.trim(),
    book: $("book").value.trim(),
    start: Number($("start").value),
    end: Number($("end").value),
    mode: $("mode").value,
    confirmEvery: Number($("confirmEvery").value || 0),
    minChars: Number($("minChars").value || 0),
    url: $("targetUrl").value.trim(),
    newUrl: $("newUrl").value.trim(),
    confirmEach: $("confirmEach").checked,
    reset: $("reset").checked,
    noStrictQuality: $("noStrictQuality").checked,
    inspectPage: $("inspectPage").checked,
  };
  Object.keys(data).forEach((key) => {
    if (data[key] === "" || Number.isNaN(data[key])) delete data[key];
  });
  return data;
}

async function post(url, body = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || "请求失败");
  return json;
}

function renderPreflight(data) {
  const errors = data.errors || [];
  const warnings = data.warnings || [];
  const rows = [
    `<div class="${data.ok ? "ok" : "error"}">${data.ok ? "预检通过" : "预检未通过"}：第 ${data.start}-${data.end} 章，扫描 ${data.scanned || 0} 章。</div>`,
    ...errors.map((item) => `<div class="error">错误：${escapeHtml(item)}</div>`),
    ...warnings.map((item) => `<div class="warn">提醒：${escapeHtml(item)}</div>`),
  ];
  preflightResult.innerHTML = rows.join("");
}

function renderUrlTest(data) {
  const errors = data.errors || [];
  const warnings = data.warnings || [];
  const rows = [
    `<div class="${data.ok ? "ok" : "error"}">${data.ok ? "后台 URL 可用" : "后台 URL 不可用"}：${escapeHtml(data.backendBook ? `《${data.backendBook}》` : data.url || "")}</div>`,
    `<div>检测结果：${data.hasBook ? "书名匹配" : "书名未匹配"}；${data.hasChapterManage ? "章节管理可见" : "章节管理未识别"}；新建章节入口 ${data.hasNewChapter ? "可见" : "未识别"}。</div>`,
    ...errors.map((item) => `<div class="error">错误：${escapeHtml(item)}</div>`),
    ...warnings.map((item) => `<div class="warn">提醒：${escapeHtml(item)}</div>`),
  ];
  urlTestResult.innerHTML = rows.join("");
}

async function runPreflight() {
  const data = await post("/api/preflight", payload());
  renderPreflight(data);
  if (!data.ok) throw new Error(data.errors.join("；"));
  return data;
}

$("startBtn").addEventListener("click", async () => {
  try {
    hideFailure();
    await runPreflight();
    const data = await post("/api/start", payload());
    renderStatus(data);
  } catch (error) {
    appendLog(`启动失败：${error.message}`);
    showFailure(`启动失败：${error.message}`);
  }
});

$("preflightBtn").addEventListener("click", async () => {
  try {
    await runPreflight();
  } catch (error) {
    appendLog(`发布前预检失败：${error.message}`);
  }
});

$("testUrlBtn").addEventListener("click", async () => {
  try {
    urlTestResult.textContent = "正在测试后台 URL...";
    const data = await post("/api/test-backend-url", {
      url: $("targetUrl").value.trim(),
      book: $("book").value.trim(),
    });
    renderUrlTest(data);
    if (!data.ok) throw new Error(data.errors.join("；"));
  } catch (error) {
    appendLog(`后台 URL 测试失败：${error.message}`);
  }
});

$("saveProjectBtn").addEventListener("click", async () => {
  try {
    const data = await post("/api/projects", {
      name: $("book").value.trim(),
      ...payload(),
    });
    renderProjects(data.projects || []);
    projectSelect.value = data.project?.id || "";
    appendLog(`已保存项目档案：${data.project?.name || data.project?.book || "未命名作品"}`);
  } catch (error) {
    appendLog(`保存项目档案失败：${error.message}`);
    showFailure(`保存项目档案失败：${error.message}`);
  }
});

projectSelect.addEventListener("change", () => {
  const project = projectItems.find((item) => item.id === projectSelect.value);
  applyProject(project);
});

$("continueBtn").addEventListener("click", async () => {
  try {
    const data = await post("/api/continue");
    renderStatus(data.status);
  } catch (error) {
    appendLog(`继续失败：${error.message}`);
  }
});

$("stopBtn").addEventListener("click", async () => {
  try {
    const data = await post("/api/stop");
    renderStatus(data.status);
  } catch (error) {
    appendLog(`停止失败：${error.message}`);
  }
});

$("refreshBtn").addEventListener("click", async () => {
  const res = await fetch("/api/status");
  renderStatus(await res.json());
});

$("scheduleBtn").addEventListener("click", async () => {
  try {
    const data = payload();
    data.intervalMinutes = Number($("intervalMinutes").value);
    data.scheduleMode = $("scheduleMode").value;
    data.batchSize = Number($("batchSize").value || 1);
    data.maxChapter = Number($("maxChapter").value || data.end || 1);
    const created = await post("/api/schedules", data);
    appendLog(`已创建定时任务：${created.name}`);
    const res = await fetch("/api/status");
    renderStatus(await res.json());
  } catch (error) {
    appendLog(`创建定时任务失败：${error.message}`);
  }
});

schedules.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-delete-schedule]");
  if (!button) return;
  const id = button.getAttribute("data-delete-schedule");
  try {
    const res = await fetch(`/api/schedules/${encodeURIComponent(id)}`, { method: "DELETE" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "删除失败");
    appendLog("已删除定时任务。");
    renderSchedules(data.schedules || []);
  } catch (error) {
    appendLog(`删除定时任务失败：${error.message}`);
  }
});

historyToggle.addEventListener("click", () => {
  historyOpen = !historyOpen;
  historyPanel.classList.toggle("hidden", !historyOpen);
  historyToggle.textContent = historyOpen ? "关闭定时任务历史" : "展开定时任务历史";
});

failureClose.addEventListener("click", hideFailure);
failureOk.addEventListener("click", hideFailure);
failureModal.addEventListener("click", (event) => {
  if (event.target === failureModal) hideFailure();
});

const events = new EventSource("/events");
events.addEventListener("log", (event) => appendLog(JSON.parse(event.data)));
events.addEventListener("status", (event) => renderStatus(JSON.parse(event.data)));
events.addEventListener("schedules", (event) => renderSchedules(JSON.parse(event.data)));
events.addEventListener("schedule-history", (event) => renderScheduleHistory(JSON.parse(event.data)));
events.addEventListener("projects", (event) => renderProjects(JSON.parse(event.data)));

fetch("/api/status").then((res) => res.json()).then(renderStatus);
