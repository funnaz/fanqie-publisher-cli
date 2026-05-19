const $ = (id) => document.getElementById(id);

const logs = $("logs");
const progress = $("progress");
const jobInfo = $("jobInfo");
const jobState = $("jobState");
const schedules = $("schedules");
const scheduleHistory = $("scheduleHistory");

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
  jobState.textContent = status.running ? "运行中" : "空闲";
  jobState.className = `state ${status.running ? "running" : "idle"}`;
  jobInfo.textContent = status.job ? JSON.stringify(status.job, null, 2) : "暂无任务";
  renderProgress(status.progress || []);
  renderSchedules(status.schedules || []);
  renderScheduleHistory(status.scheduleHistory || []);
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

$("startBtn").addEventListener("click", async () => {
  try {
    const data = await post("/api/start", payload());
    renderStatus(data);
  } catch (error) {
    appendLog(`启动失败：${error.message}`);
  }
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

const events = new EventSource("/events");
events.addEventListener("log", (event) => appendLog(JSON.parse(event.data)));
events.addEventListener("status", (event) => renderStatus(JSON.parse(event.data)));
events.addEventListener("schedules", (event) => renderSchedules(JSON.parse(event.data)));
events.addEventListener("schedule-history", (event) => renderScheduleHistory(JSON.parse(event.data)));

fetch("/api/status").then((res) => res.json()).then(renderStatus);
