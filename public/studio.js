const $ = (id) => document.getElementById(id);

let overviewState = null;
let aiConfigState = null;
let statusState = null;
let lastAiReviewReport = "";
let lastRevisionDir = "";

async function loadAuth() {
  const res = await fetch("/api/auth/status");
  const data = await res.json();
  if (!data.authenticated) {
    window.location.href = "/login.html";
    return null;
  }
  $("userChip").textContent = data.user?.displayName || data.user?.username || "已登录";
  return data.user;
}

async function logout() {
  await fetch("/api/auth/logout", { method: "POST" });
  window.location.href = "/login.html";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatTime(value) {
  if (!value) return "等待刷新";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function rangeForCheck(latestChapter) {
  const end = Math.max(1, Number(latestChapter || 1));
  const start = Math.max(1, end - 9);
  return { start, end };
}

function qualityRange() {
  const start = Math.max(1, Number($("qualityStart").value || 1));
  const end = Math.max(start, Number($("qualityEnd").value || start));
  const minPureChars = Math.max(1, Number($("qualityMinWords").value || 1020));
  $("qualityStart").value = start;
  $("qualityEnd").value = end;
  $("qualityMinWords").value = minPureChars;
  return { start, end, minPureChars };
}

function renderOverview(overview) {
  overviewState = overview;
  const main = overview.mainProject || {};
  const latest = Number(main.latestChapter || main.chapters || 0);

  $("mainProjectName").textContent = main.name || "未发现主项目";
  $("mainProjectChapters").textContent = latest ? `${latest} 章` : "未发现";
  $("mainProjectCheck").textContent = main.publishedTo ? `已发布到 ${main.publishedTo} 章` : (latest ? `可检查 1-${latest} 章` : "等待正文");
  $("mainProjectNext").textContent = main.next || "等待生成";
  $("taskMainNovel").textContent = latest ? `检查《${main.name || "主项目"}》1-${latest} 章` : "读取主项目章节";
  $("currentChaptersPath").textContent = main.chaptersPath || "未发现";
  $("overviewUpdated").textContent = `更新于 ${formatTime(overview.updatedAt)}`;

  const rows = overview.rows || [];
  renderQualityProjectOptions(rows);
  $("novelRows").innerHTML = rows.length ? rows.map((item) => `
    <tr>
      <td><strong>${escapeHtml(item.name)}</strong></td>
      <td>${escapeHtml(item.chapters ?? item.works ?? 0)}</td>
      <td>${escapeHtml(item.status || "-")}</td>
      <td>${escapeHtml(item.next || "-")}</td>
    </tr>
  `).join("") : `<tr><td colspan="4">还没有读取到作品</td></tr>`;

  const pipeline = overview.pipeline || [];
  $("pipeline").innerHTML = pipeline.map(([title, body]) => `
    <div class="pipeline-step">
      <strong>${escapeHtml(title)}</strong>
      <span>${escapeHtml(body)}</span>
    </div>
  `).join("");
}

function renderQualityProjectOptions(rows = []) {
  const select = $("qualityProjectSelect");
  if (!select) return;
  const current = select.value;
  const candidates = rows.filter((item) => item.chaptersPath && Number(item.latestChapter || item.chapters || 0) > 0);
  select.innerHTML = candidates.length ? candidates.map((item) => `
    <option value="${escapeHtml(item.chaptersPath)}" data-latest="${escapeHtml(item.latestChapter || item.chapters || 1)}">
      ${escapeHtml(item.name || "未命名作品")}（${escapeHtml(item.latestChapter || item.chapters || 0)}章）
    </option>
  `).join("") : `<option value="">未发现可检查作品</option>`;
  if (candidates.some((item) => item.chaptersPath === current)) {
    select.value = current;
    return;
  }
  const mainPath = overviewState?.mainProject?.chaptersPath;
  const defaultItem = candidates.find((item) => item.chaptersPath === mainPath) || candidates[0];
  if (defaultItem) select.value = defaultItem.chaptersPath;
}

function findMainProgress(status) {
  const mainPath = overviewState?.mainProject?.chaptersPath;
  const items = status.progress || [];
  if (!mainPath) return items[0];
  return items.find((item) => String(item.chapters || "").toLowerCase() === String(mainPath).toLowerCase())
    || items.find((item) => String(item.chapters || "").includes("苍生印_重写版"));
}

function renderStatus(status) {
  statusState = status;
  const running = Boolean(status.running);
  const studioRunning = Boolean(status.studioRunning);
  $("jobBadge").textContent = running || studioRunning ? "运行中" : "空闲";
  $("jobBadge").className = `pill ${running || studioRunning ? "running" : "neutral"}`;
  $("jobSummary").textContent = status.job?.options?.mode || "暂无发布任务";
  $("studioJobSummary").textContent = studioRunning
    ? `${status.studioJob?.options?.action === "batch" ? "续写正文" : "搭建故事系统"}，${status.studioJob?.options?.batchSize || 10}章/批`
    : (status.studioJob?.exited ? `已结束，退出码 ${status.studioJob.exitCode}` : "暂无生成任务");

  const progress = findMainProgress(status);
  $("uploadProgress").textContent = progress ? `${progress.uploadedTo || 0} 章` : "暂无记录";
  $("publishProgress").textContent = progress ? `${progress.publishedTo || 0} 章` : "暂无记录";
  $("scheduleCount").textContent = `${(status.schedules || []).length} 个`;
  renderHealth(status.health);

  $("studioJobBadge").textContent = studioRunning ? "生成中" : "空闲";
  $("studioJobBadge").className = `pill ${studioRunning ? "running" : "neutral"}`;

  const hints = [];
  if (status.studioOutputRoot) hints.push(`生成结果会保存到：${status.studioOutputRoot}`);
  if (status.aiConfig) {
    renderAiConfig(status.aiConfig);
    const source = status.aiConfig.provider === "local" ? "本地备用" : "云端模型";
    hints.push(`AI模型：${status.aiConfig.configured ? "已配置" : "未配置"}；${source}；当前模型：${status.aiConfig.model}`);
  }
  $("generatorHint").textContent = hints.join("；") || "生成结果会保存到：AI小说工作室 / 生成作品";

  const logs = (status.logs || []).slice(-80).map((entry) => {
    if (typeof entry === "string") return entry;
    return `[${entry.time}] ${entry.message}`;
  });
  $("logs").textContent = logs.length ? logs.join("\n") : "暂无日志";
  $("logs").scrollTop = $("logs").scrollHeight;
}

function renderHealth(health) {
  if (!$("healthBadge") || !$("healthList")) return;
  if (!health) {
    $("healthBadge").textContent = "未读取";
    $("healthBadge").className = "health-badge warn";
    $("healthList").innerHTML = `<li class="warn">等待后台自检</li>`;
    return;
  }
  $("healthBadge").textContent = health.ready ? "可运行" : "需处理";
  $("healthBadge").className = `health-badge ${health.ready ? "ok" : "error"}`;
  const rows = [
    ...(health.issues || []).map((text) => ({ type: "error", text })),
    ...(health.warnings || []).map((text) => ({ type: "warn", text })),
    ...(health.ok || []).slice(0, 3).map((text) => ({ type: "ok", text })),
  ];
  $("healthList").innerHTML = rows.length
    ? rows.map((item) => `<li class="${item.type}">${escapeHtml(item.text)}</li>`).join("")
    : `<li class="ok">未发现问题</li>`;
}

function renderAiConfig(config) {
  if (!$("aiProvider")) return;
  aiConfigState = config;
  renderSavedModelOptions(config);
  $("aiProvider").value = config.provider || "cloud";
  $("aiBaseUrl").value = config.baseUrl || "";
  $("aiModel").value = config.model || "";
  $("aiApiKey").value = "";
  $("aiProviderBadge").textContent = config.provider === "local" ? "本地备用" : "云端模型";
  $("aiProviderBadge").className = `pill ${config.configured ? "running" : "neutral"}`;
  const keyText = config.hasApiKey ? "Key已保存" : "未保存Key";
  const cloud = config.profiles?.cloud;
  const local = config.profiles?.local;
  const cloudText = cloud?.model ? `云端：${cloud.model}` : "云端：未配置";
  const localText = local?.model ? `本地：${local.model}` : "本地：未配置";
  $("aiConfigHint").textContent = `${keyText}；当前使用 ${config.model || "未设置模型"}。${cloudText}；${localText}`;
}

function renderSavedModelOptions(config) {
  const select = $("savedModelSelect");
  if (!select) return;
  const active = config.provider || "cloud";
  const profiles = config.profiles || {};
  const rows = ["cloud", "local"].map((provider) => {
    const profile = profiles[provider] || {};
    const label = provider === "cloud" ? "云端模型" : "本地备用";
    const model = profile.model || "未配置";
    return `<option value="${provider}">${label}：${escapeHtml(model)}</option>`;
  });
  select.innerHTML = rows.join("");
  select.value = active;
}

async function saveAiConfig(payload) {
  const res = await fetch("/api/studio/ai-config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "保存AI配置失败");
  renderAiConfig(data);
  await refreshStatus();
}

function fillAiProfile(provider) {
  const profile = aiConfigState?.profiles?.[provider];
  $("aiProvider").value = provider;
  if ($("savedModelSelect")) $("savedModelSelect").value = provider;
  if (profile) {
    $("aiBaseUrl").value = profile.baseUrl || "";
    $("aiModel").value = profile.model || "";
    $("aiApiKey").value = "";
  }
}

function highlightPanel(id) {
  const panel = $(id);
  if (!panel) return;
  panel.scrollIntoView({ behavior: "smooth", block: "center" });
  panel.classList.remove("focus-glow");
  window.setTimeout(() => panel.classList.add("focus-glow"), 20);
  window.setTimeout(() => panel.classList.remove("focus-glow"), 2020);
}

function showNotice(message) {
  const current = $("logs").textContent;
  $("logs").textContent = `${current}\n[页面] ${message}`.trim();
  $("logs").scrollTop = $("logs").scrollHeight;
}

async function refreshOverview() {
  const res = await fetch("/api/studio/overview");
  if (!res.ok) throw new Error("读取总控台数据失败");
  renderOverview(await res.json());
}

async function refreshStatus() {
  const res = await fetch("/api/status");
  if (!res.ok) throw new Error("读取运行状态失败");
  renderStatus(await res.json());
}

async function refreshAll() {
  await refreshOverview();
  await refreshStatus();
  $("refreshBtn").textContent = `已刷新 ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`;
  setTimeout(() => {
    $("refreshBtn").textContent = "刷新工作台";
  }, 2500);
}

async function startDryRun(start, end) {
  const chapters = qualityChaptersPath();
  if (!chapters) throw new Error("没有找到主项目章节目录");
  const body = { chapters, mode: "dry-run", start, end, minChars: 1000, reset: false };
  const res = await fetch("/api/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "启动检查失败");
  renderStatus(data);
}

function qualityChaptersPath() {
  return $("qualityProjectSelect")?.value || overviewState?.mainProject?.chaptersPath || "";
}

function selectedQualityProject() {
  const chaptersPath = qualityChaptersPath();
  return (overviewState?.rows || []).find((item) => item.chaptersPath === chaptersPath) || null;
}

function selectedQualityLatestChapter() {
  const project = selectedQualityProject();
  return Number(project?.latestChapter || project?.chapters || 1);
}

async function openQualityProjectFolder() {
  const chapters = qualityChaptersPath();
  if (!chapters) throw new Error("没有找到可打开的作品目录");
  const res = await fetch("/api/studio/open-folder", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chapters }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "打开作品文件夹失败");
  showNotice(`已打开作品文件夹：${data.folder}`);
}

async function fixFormat(start, end) {
  const chapters = qualityChaptersPath();
  if (!chapters) throw new Error("没有找到可修复的章节目录");
  const res = await fetch("/api/studio/fix-format", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chapters, start, end }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "自动修复格式失败");
  renderStatus(data.status);
  showNotice(`格式修复完成：扫描 ${data.scanned} 章，修复 ${data.changed.length} 章。`);
  await refreshOverview();
}

async function cleanChapterRefs(start, end) {
  const chapters = qualityChaptersPath();
  if (!chapters) throw new Error("没有找到可清理的章节目录");
  const res = await fetch("/api/studio/clean-chapter-refs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chapters, start, end }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "清理章节引用失败");
  renderStatus(data.status);
  const lines = [
    `章节引用清理完成：扫描 ${data.scanned} 章，修改 ${data.changed.length} 章。`,
    "",
    ...(data.changed || []).slice(0, 60).map((item) => `第 ${item.no} 章：${item.count} 处`),
  ];
  if ((data.changed || []).length > 60) lines.push(`另有 ${data.changed.length - 60} 章已修改，列表省略。`);
  $("qualityAiResult").textContent = lines.join("\n");
  showNotice(`章节引用清理完成：修改 ${data.changed.length} 章。`);
  await refreshOverview();
}

async function checkWordCount(start, end, minPureChars) {
  const chapters = qualityChaptersPath();
  if (!chapters) throw new Error("没有找到可检查的章节目录");
  const res = await fetch("/api/studio/check-words", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chapters, start, end, minPureChars }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "字数检查失败");
  renderStatus(data.status);
  showNotice(`字数检查完成：扫描 ${data.scanned} 章，不达标 ${data.failed.length} 章。要求纯文字大于 ${data.minPureChars} 字。`);
}

async function reviewPlotWithAi(start, end) {
  const chapters = qualityChaptersPath();
  if (!chapters) throw new Error("没有找到可批改的章节目录");
  $("qualityAiResult").textContent = "AI正在批改剧情，请稍等...";
  const res = await fetch("/api/studio/ai-review", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chapters, start, end }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "AI剧情批改失败");
  renderStatus(data.status);
  lastAiReviewReport = data.report || "";
  lastRevisionDir = "";
  $("qualityAiResult").textContent = data.report || "AI没有返回批改结果。";
  showNotice(`AI剧情批改完成：已检查第 ${data.start}-${data.end} 章。`);
}

async function generateRevisionDraft(start, end) {
  const chapters = qualityChaptersPath();
  if (!chapters) throw new Error("没有找到可修改的章节目录");
  if (!lastAiReviewReport) throw new Error("请先运行 AI剧情批改，再生成修改稿。");
  $("qualityAiResult").textContent = "AI正在生成修改稿，原文不会被覆盖...";
  const res = await fetch("/api/studio/rewrite-draft", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chapters, start, end, review: lastAiReviewReport }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "生成修改稿失败");
  renderStatus(data.status);
  lastRevisionDir = data.revisionDir || "";
  $("qualityAiResult").textContent = [
    `修改稿已生成：${data.revisionDir}`,
    `扫描 ${data.scanned} 章，生成 ${data.changed.length} 章。`,
    "",
    ...(data.changed || []).map((item) => `第 ${item.no} 章：${item.file}`),
  ].join("\n");
  showNotice(`修改稿已生成：${data.changed.length} 章，确认后才会覆盖原文。`);
}

async function applyRevisionDraft() {
  const chapters = qualityChaptersPath();
  if (!chapters) throw new Error("没有找到章节目录");
  if (!lastRevisionDir) throw new Error("还没有可覆盖的修改稿，请先生成修改稿。");
  const ok = window.confirm("确认用最新修改稿覆盖原文章节？系统会先备份原文。");
  if (!ok) return;
  const res = await fetch("/api/studio/apply-rewrite", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chapters, revisionDir: lastRevisionDir }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "覆盖原文失败");
  renderStatus(data.status);
  $("qualityAiResult").textContent = [
    `已覆盖原文：${data.applied.length} 章。`,
    `原文备份：${data.backupDir}`,
    "",
    ...(data.applied || []).map((item) => `第 ${item.no} 章：${item.file}`),
  ].join("\n");
  showNotice(`已覆盖原文：${data.applied.length} 章，原文已备份。`);
  await refreshOverview();
}

function generationPayload(action) {
  const minWords = Math.max(600, Math.min(5000, Number($("genMinWords").value || 1050)));
  const maxWords = Math.max(minWords, Math.min(5000, Number($("genMaxWords").value || 1300)));
  const batchSize = Math.max(1, Math.min(200, Number($("genBatchSize").value || 10)));
  $("genMinWords").value = minWords;
  $("genMaxWords").value = maxWords;
  $("genBatchSize").value = batchSize;
  return {
    action,
    title: $("genTitle").value.trim() || "未命名小说",
    genre: $("genGenre").value,
    audience: $("genAudience").value.trim() || "网文读者",
    premise: $("genPremise").value.trim() || "凡人少年在乱世中逆命而行。",
    chapters: Math.max(1, Math.min(2000, Number($("genChapters").value || 3))),
    minWords,
    maxWords,
    words: minWords,
    batchSize,
    engine: $("genEngine").value,
    model: $("genModel").value.trim() || $("aiModel").value.trim(),
  };
}

async function startGeneration(action) {
  const res = await fetch("/api/studio/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(generationPayload(action)),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "启动生成失败");
  renderStatus(data);
}

async function stopGeneration() {
  const res = await fetch("/api/studio/stop", { method: "POST" });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "停止生成失败");
  renderStatus(data.status);
}

function bindActions() {
  $("logoutBtn").addEventListener("click", () => logout().catch(showError));
  $("refreshBtn").addEventListener("click", () => refreshAll().catch(showError));
  $("dryRunBtn").addEventListener("click", () => {
    const latest = overviewState?.mainProject?.latestChapter || overviewState?.mainProject?.chapters || 1;
    startDryRun(1, latest).catch(showError);
  });
  $("checkNextBtn").addEventListener("click", () => {
    const { start, end } = rangeForCheck(overviewState?.mainProject?.latestChapter);
    startDryRun(start, end).catch(showError);
  });
  $("openDryRunPlan").addEventListener("click", () => {
    const latest = overviewState?.mainProject?.latestChapter || overviewState?.mainProject?.chapters || 1;
    startDryRun(1, latest).catch(showError);
  });
  $("generateProjectBtn").addEventListener("click", () => startGeneration("project").catch(showError));
  $("generateBatchBtn").addEventListener("click", () => startGeneration("batch").catch(showError));
  $("stopGenerateBtn").addEventListener("click", () => stopGeneration().catch(showError));
  document.querySelectorAll(".batch-preset").forEach((button) => {
    button.addEventListener("click", () => {
      $("genBatchSize").value = button.dataset.batch || "10";
      startGeneration("batch").catch(showError);
    });
  });
  $("workflowCheckAll").addEventListener("click", () => {
    highlightPanel("qualityPanel");
  });
  $("workflowGenerateProject").addEventListener("click", () => highlightPanel("generationPanel"));
  $("workflowContinueBatch").addEventListener("click", () => highlightPanel("generationPanel"));
  $("workflowOpenPublisher").addEventListener("click", () => highlightPanel("opsPanel"));
  $("savedModelSelect").addEventListener("change", () => fillAiProfile($("savedModelSelect").value));
  $("aiProvider").addEventListener("change", () => fillAiProfile($("aiProvider").value));
  $("saveAiConfigBtn").addEventListener("click", () => saveAiConfig({
    provider: $("aiProvider").value,
    baseUrl: $("aiBaseUrl").value.trim(),
    model: $("aiModel").value.trim(),
    apiKey: $("aiApiKey").value.trim(),
  }).catch(showError));
  $("useCloudAiBtn").addEventListener("click", () => {
    fillAiProfile("cloud");
    saveAiConfig({
      provider: "cloud",
      baseUrl: $("aiBaseUrl").value.trim(),
      model: $("aiModel").value.trim(),
      apiKey: $("aiApiKey").value.trim(),
    }).catch(showError);
  });
  $("useLocalAiBtn").addEventListener("click", () => saveAiConfig({
    provider: "local",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "qwen2.5:3b",
    apiKey: "ollama",
  }).catch(showError));
  $("qualityOpenFolderBtn").addEventListener("click", () => {
    openQualityProjectFolder().catch(showError);
  });
  $("qualityFixFormatBtn").addEventListener("click", () => {
    const { start, end } = qualityRange();
    fixFormat(start, end).catch(showError);
  });
  $("qualityCleanChapterRefsBtn").addEventListener("click", () => {
    const { start, end } = qualityRange();
    cleanChapterRefs(start, end).catch(showError);
  });
  $("qualityWordCountBtn").addEventListener("click", () => {
    const { start, end, minPureChars } = qualityRange();
    checkWordCount(start, end, minPureChars).catch(showError);
  });
  $("qualityCheckAllBtn").addEventListener("click", () => {
    const latest = selectedQualityLatestChapter();
    $("qualityStart").value = 1;
    $("qualityEnd").value = latest;
    startDryRun(1, latest).catch(showError);
  });
  $("qualityCheckRecentBtn").addEventListener("click", () => {
    const latest = selectedQualityLatestChapter();
    const { start, end } = rangeForCheck(latest);
    $("qualityStart").value = start;
    $("qualityEnd").value = end;
    startDryRun(start, end).catch(showError);
  });
  $("qualityAiReviewBtn").addEventListener("click", () => {
    const { start, end } = qualityRange();
    reviewPlotWithAi(start, end).catch(showError);
  });
  $("qualityDraftRewriteBtn").addEventListener("click", () => {
    const { start, end } = qualityRange();
    generateRevisionDraft(start, end).catch(showError);
  });
  $("qualityApplyRewriteBtn").addEventListener("click", () => {
    applyRevisionDraft().catch(showError);
  });
}

function showError(error) {
  const current = $("logs").textContent;
  $("logs").textContent = `${current}\n[页面] ${error.message || error}`.trim();
}

loadAuth().then((user) => {
  if (!user) return;
  bindActions();
  refreshAll().catch(showError);

  const events = new EventSource("/events");
  events.addEventListener("status", (event) => renderStatus(JSON.parse(event.data)));
  events.addEventListener("log", () => refreshStatus().catch(showError));
}).catch(showError);

setInterval(() => {
  if (statusState?.running || statusState?.studioRunning) refreshStatus().catch(showError);
}, 3000);
