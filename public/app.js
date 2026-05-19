const $ = (id) => document.getElementById(id);

const logs = $("logs");
const progress = $("progress");
const jobInfo = $("jobInfo");
const jobState = $("jobState");

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

const events = new EventSource("/events");
events.addEventListener("log", (event) => appendLog(JSON.parse(event.data)));
events.addEventListener("status", (event) => renderStatus(JSON.parse(event.data)));

fetch("/api/status").then((res) => res.json()).then(renderStatus);
