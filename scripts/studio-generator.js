const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const args = {
    title: "未命名小说",
    genre: "东方玄幻",
    premise: "凡人少年在乱世中逆命而行。",
    audience: "网文读者",
    chapters: 3,
    words: 1200,
    minWords: 1050,
    maxWords: 1300,
    engine: "ai",
    model: "",
    outputRoot: path.resolve(process.cwd(), "..", "AI小说工作室", "生成作品"),
    action: "project",
    batchSize: 10,
  };
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i];
    const next = argv[i + 1];
    if (key === "--config" && next) {
      Object.assign(args, JSON.parse(fs.readFileSync(path.resolve(next), "utf8")));
      i++;
    } else if (key === "--title" && next) args.title = next, i++;
    else if (key === "--genre" && next) args.genre = next, i++;
    else if (key === "--premise" && next) args.premise = next, i++;
    else if (key === "--audience" && next) args.audience = next, i++;
    else if (key === "--chapters" && next) args.chapters = Number(next), i++;
    else if (key === "--words" && next) args.words = Number(next), i++;
    else if (key === "--min-words" && next) args.minWords = Number(next), i++;
    else if (key === "--max-words" && next) args.maxWords = Number(next), i++;
    else if (key === "--engine" && next) args.engine = next, i++;
    else if (key === "--model" && next) args.model = next, i++;
    else if (key === "--output-root" && next) args.outputRoot = path.resolve(next), i++;
    else if (key === "--action" && next) args.action = next, i++;
    else if (key === "--batch-size" && next) args.batchSize = Number(next), i++;
  }
  args.chapters = Math.max(1, Math.min(2000, Number(args.chapters) || 3));
  args.minWords = Math.max(600, Math.min(5000, Number(args.minWords || args.words) || 1050));
  args.maxWords = Math.max(args.minWords, Math.min(5000, Number(args.maxWords) || 1300));
  args.words = args.minWords;
  args.engine = args.engine === "template" ? "template" : "ai";
  args.action = args.action === "batch" ? "batch" : "project";
  args.batchSize = Math.max(1, Math.min(200, Number(args.batchSize) || 10));
  return args;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function safeName(name) {
  return String(name || "").replace(/[\\/:*?"<>|]/g, "").trim() || "未命名小说";
}

function uniqueDir(root, title) {
  ensureDir(root);
  const base = path.join(root, safeName(title));
  if (!fs.existsSync(base)) return base;
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `${base}_${stamp}`;
}

function latestProjectDir(root, title) {
  if (!fs.existsSync(root)) return null;
  const base = safeName(title);
  const candidates = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && (entry.name === base || entry.name.startsWith(`${base}_`)))
    .map((entry) => {
      const full = path.join(root, entry.name);
      return { full, mtime: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  return candidates[0]?.full || null;
}

function listChapterFiles(chaptersRoot) {
  const files = [];
  if (!fs.existsSync(chaptersRoot)) return files;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && /^(\d{3,})-/.test(entry.name)) files.push(full);
    }
  };
  walk(chaptersRoot);
  return files.sort();
}

function latestChapterNo(bookDir) {
  const files = listChapterFiles(path.join(bookDir, "chapters"));
  let max = 0;
  for (const file of files) {
    const no = Number(path.basename(file).match(/^(\d+)/)?.[1] || 0);
    if (no > max) max = no;
  }
  return max;
}

function normalize(text) {
  return String(text || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/\r?\n/g, "\r\n")
    .replace(/\r\n{3,}/g, "\r\n\r\n")
    .trim() + "\r\n";
}

function countChars(text) {
  return Array.from(String(text).replace(/\s/g, "")).length;
}

function wordRangeText(args) {
  return `${args.minWords}-${args.maxWords}字`;
}

function loadDashenSkillPrompt() {
  const file = path.resolve(__dirname, "..", "prompts", "dashen-novel-skill.md");
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

function repeatedLineRatio(text) {
  const lines = String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 12);
  if (lines.length < 6) return 0;
  const seen = new Set();
  let repeated = 0;
  for (const line of lines) {
    if (seen.has(line)) repeated++;
    seen.add(line);
  }
  return repeated / lines.length;
}

function tooSimilarToPrior(text, prior) {
  const clean = String(text).replace(/\s/g, "");
  if (!clean || !prior.length) return false;
  const start = clean.slice(0, 120);
  return prior.slice(-3).some((item) => item.opening && item.opening === start);
}

function chapterDir(bookDir, chapter) {
  const start = Math.floor((chapter - 1) / 20) * 20 + 1;
  const end = start + 19;
  return path.join(bookDir, "chapters", `${String(start).padStart(3, "0")}-${String(end).padStart(3, "0")}`);
}

function aiConfig(args) {
  return {
    apiKey: process.env.AI_API_KEY || process.env.OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY,
    baseUrl: (process.env.AI_BASE_URL || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, ""),
    model: args.model || process.env.AI_MODEL || process.env.OPENAI_MODEL || "gpt-4.1-mini",
  };
}

async function callAi(args, messages, temperature = 0.75) {
  const cfg = aiConfig(args);
  if (!cfg.apiKey) throw new Error("未配置 AI_API_KEY / OPENAI_API_KEY / DEEPSEEK_API_KEY");
  const timeoutMs = Number(process.env.STUDIO_AI_TIMEOUT_MS || 120000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const payload = { model: cfg.model, messages, temperature };
  if (/deepseek/i.test(cfg.baseUrl) || /deepseek-v4/i.test(cfg.model)) {
    payload.thinking = { type: "disabled" };
  }
  const response = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    signal: controller.signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify(payload),
  }).finally(() => clearTimeout(timer));
  const body = await response.text();
  if (!response.ok) throw new Error(`AI 调用失败：${response.status} ${body.slice(0, 500)}`);
  const data = JSON.parse(body);
  const content = normalize(data.choices?.[0]?.message?.content || "");
  if (countChars(content) < 80) throw new Error("AI 返回内容过短");
  return content;
}

function isSmallLocalModel(args) {
  const model = aiConfig(args).model || "";
  return /qwen3:1\.7b|1\.7b|0\.5b|1b/i.test(model);
}

function isLocalAi(args) {
  const cfg = aiConfig(args);
  return /127\.0\.0\.1|localhost|ollama/i.test(cfg.baseUrl) || /qwen|llama|mistral|gemma|phi/i.test(cfg.model || "");
}

function shouldPlanOnly(args) {
  return args.action === "project" && isSmallLocalModel(args) && args.chapters > 10;
}

function sampleChapterCount(args) {
  if (args.action === "project") return Math.min(args.chapters, 10);
  return Math.min(args.chapters, args.batchSize);
}

const PIPELINE_TEXT = "作品定位 → 世界规则 → 人物驱动 → 长线结构 → 单元冲突 → 章节任务 → 正文表达 → 连贯性校验 → 节奏优化";

function systemPrompt(args) {
  return [
    "你是中文网文工作室的长篇小说主笔。",
    "必须根据用户给出的书名、类型、核心创意生成，不得套用其他已有作品设定。",
    `生产顺序：${PIPELINE_TEXT}。`,
    "原则：先保证故事能长出来，再保证每一章好看。",
    "写作优先级：具体场景 > 明确冲突 > 主角选择 > 反转钩子 > 语言润色。",
    "不要写创作说明，不要复述规则，只输出可保存到文件的内容。",
    `类型：${args.genre}`,
    `目标读者：${args.audience}`,
    "",
    loadDashenSkillPrompt(),
  ].join("\n");
}

async function aiArchitecture(args) {
  return callAi(args, [
    { role: "system", content: systemPrompt(args) },
    {
      role: "user",
      content: [
        `书名：《${args.title}》`,
        `核心创意：${args.premise}`,
        "",
        "先搭建可长期连载的故事生产系统，再生成总设定。",
        "必须按以下九段输出，每段都要具体可执行：",
        "1. 作品定位：读者、类型承诺、核心爽点、一句话卖点。",
        "2. 世界规则：时代、势力、力量体系、限制、代价、禁忌。",
        "3. 人物驱动：主角欲望、短板、行动方式、关键关系、主要对手。",
        "4. 长线结构：分卷目标、长线谜团、伏笔、承诺兑现、卷末高潮。",
        "5. 单元冲突：每20章一个单元的目标、阻力、升级、反转、阶段钩子。",
        "6. 章节任务规则：每章如何从单元冲突拆成可写任务。",
        "7. 正文表达规则：场景、动作、对白、压力、选择、反转、钩子。",
        "8. 连贯性校验规则：人物口吻、设定、因果、伏笔、前文风格。",
        "9. 节奏优化规则：开场推进、冲突密度、爽点兑现、段落去重、结尾钩子。",
      ].join("\n"),
    },
  ], 0.65);
}

async function aiBlueprint(args, architecture) {
  return callAi(args, [
    { role: "system", content: systemPrompt(args) },
    {
      role: "user",
      content: [
        `书名：《${args.title}》`,
        `规划章节数：${args.chapters}`,
        `总设定：\n${architecture}`,
        "",
        "生成可执行长线章纲，必须先保证故事能长出来，再保证每一章好看。",
        "若章节很多，按每20章一个单元写：单元目标、主要冲突、人物变化、关键反转、阶段钩子、必须回收的伏笔。",
        "前10章必须逐章详细列出，每章都要包含：作品定位承接、世界规则触发、人物驱动、所属单元冲突、章节任务、正文表达重点、连贯性风险、节奏优化点。",
        "每章的场景、冲突对象、爽点兑现、反转、钩子都必须不同。",
        "禁止每章只改标题、功能句重复、冲突句重复。",
      ].join("\n"),
    },
  ], 0.65);
}

function extractChapterTask(blueprint, no) {
  const text = String(blueprint || "");
  const escapedNo = String(no).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const nextNo = String(no + 1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`第\\s*${escapedNo}\\s*章[\\s\\S]*?(?=\\n\\s*第\\s*${nextNo}\\s*章|\\n\\s*第\\s*\\d+\\s*[-—至到]|$)`),
    new RegExp(`${escapedNo}[\\.、\\s-]+[\\s\\S]*?(?=\\n\\s*${nextNo}[\\.、\\s-]+|$)`),
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[0].trim().length > 20) return match[0].trim().slice(0, 1800);
  }
  return `第${no}章任务：承接前文，推动当前单元冲突，制造主角主动选择，完成一次信息变化或爽点兑现，结尾留下自然钩子。`;
}

async function aiQualityReview(args, architecture, blueprint, prior, no, chapter) {
  const recent = prior.slice(-3).map((item) => `第${item.no}章：${item.summary}`).join("\n") || "开篇。";
  const task = extractChapterTask(blueprint, no);
  return callAi(args, [
    { role: "system", content: [
      "你是中文网文工作室的质量总编，只判断是否合格，不重写正文。",
      "检查顺序：作品定位、世界规则、人物驱动、长线结构、单元冲突、章节任务、正文表达、连贯性、节奏。",
      "必须严格挑问题，但只把会导致后续剧情断裂、人物崩坏、设定冲突、正文不可发布的问题判为不合格。",
      "普通可优化问题只写入issues，pass仍可为true。",
    ].join("\n") },
    {
      role: "user",
      content: [
        `书名：《${args.title}》`,
        `当前章节：第${no}章`,
        `目标字数：${wordRangeText(args)}`,
        `总设定：\n${architecture.slice(0, 5000)}`,
        `章节任务：\n${task}`,
        `最近剧情：\n${recent}`,
        "",
        "请检查下面正文是否可以保存为正式章节。",
        "只输出JSON，不要Markdown：",
        "{\"pass\":true,\"score\":85,\"issues\":[\"具体问题\"],\"rewriteInstruction\":\"若不合格，给出重写指令\"}",
        "",
        chapter.text,
      ].join("\n\n"),
    },
  ], 0.2);
}

function parseQualityResult(raw) {
  const text = String(raw || "").replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  try {
    const match = text.match(/\{[\s\S]*\}/);
    const data = JSON.parse(match ? match[0] : text);
    return {
      pass: Boolean(data.pass),
      score: Number(data.score || 0),
      issues: Array.isArray(data.issues) ? data.issues.map(String) : [],
      rewriteInstruction: String(data.rewriteInstruction || ""),
      raw: text,
    };
  } catch {
    return { pass: false, score: 0, issues: ["质量校验返回格式异常"], rewriteInstruction: "重写本章，严格按章节任务输出正文。", raw: text };
  }
}

function isBlockingQualityFailure(report) {
  if (report.pass && report.score >= 70) return false;
  const joined = `${report.issues.join("；")}；${report.rewriteInstruction}`;
  if (/断裂|崩|冲突|矛盾|未完成|不成立|不可发布|标题不符|任务未完成|正文为空|过短|重复|相似/.test(joined)) return true;
  return Number(report.score || 0) < 60;
}

async function checkAndRewriteChapter(args, architecture, blueprint, prior, no, chapter) {
  const reports = [];
  let current = chapter;
  for (let attempt = 0; attempt < 3; attempt++) {
    let report = {
      pass: true,
      score: 80,
      issues: [],
      rewriteInstruction: "",
      raw: "local-pass",
    };
    if (repeatedLineRatio(current.text) > 0.08) {
      report = { pass: false, score: 45, issues: ["本章疑似存在重复句段"], rewriteInstruction: "彻底重写，换场景推进和段落结构。", raw: "local-repeat" };
    } else if (tooSimilarToPrior(current.text, prior)) {
      report = { pass: false, score: 45, issues: ["与最近章节开场或结构过于相似"], rewriteInstruction: "彻底重写，换开场、冲突对象和爽点兑现方式。", raw: "local-similar" };
    } else if (args.engine === "ai") {
      report = parseQualityResult(await aiQualityReview(args, architecture, blueprint, prior, no, current));
    }
    reports.push({ attempt: attempt + 1, ...report });
    if (!isBlockingQualityFailure(report)) return { chapter: current, reports, blocked: false };
    if (attempt >= 2) break;
    const instruction = [
      "上一版未通过质量校验，必须重写本章。",
      `问题：${report.issues.join("；") || "质量不足"}`,
      report.rewriteInstruction,
      "重写要求：不保留原段落，先完成章节任务，再优化场景、冲突、主角选择、反转和钩子。",
    ].filter(Boolean).join("\n");
    const rewritten = await aiChapter(args, architecture, blueprint, prior, no, instruction, { skipQualityGate: true });
    current = rewritten;
  }
  const last = reports.at(-1);
  return {
    chapter: current,
    reports,
    blocked: true,
    reason: `第 ${no} 章质量校验未通过：${last?.issues?.join("；") || "未知问题"}`,
  };
}

async function aiChapter(args, architecture, blueprint, prior, no, extraInstruction = "", options = {}) {
  const recent = prior.slice(-3).map((item) => `第${item.no}章：${item.summary}`).join("\n") || "开篇。";
  const chapterTask = extractChapterTask(blueprint, no);
  const buildMessages = (extra = "") => [
    { role: "system", content: systemPrompt(args) },
    {
      role: "user",
      content: [
        `书名：《${args.title}》`,
        `当前章节：第${no}章`,
        `目标字数：${wordRangeText(args)}`,
        `总设定：\n${architecture}`,
        `当前章节任务：\n${chapterTask}`,
        `最近剧情：\n${recent}`,
        "",
        "先在脑中完成：作品定位 → 世界规则 → 人物驱动 → 长线结构 → 单元冲突 → 章节任务 → 正文表达 → 连贯性校验 → 节奏优化，然后只输出正文。",
        "直接写本章正文。第一行必须是“第X章 标题”，第二行空行，然后正文。不要输出分析、清单、标签或校验报告。",
        `正文必须控制在${wordRangeText(args)}，不要超出最高字数；宁可收束场景，也不要继续扩写。`,
        "必须有具体场景、人物动作、冲突升级、主角选择和结尾钩子。",
        "不得复用最近三章的开场、嘲讽句、测验桥段或段落结构。",
        extraInstruction,
        extra,
      ].filter(Boolean).join("\n\n"),
    },
  ];

  let content = await callAi(args, buildMessages(), 0.82);
  let chapter = normalizeChapterText(args, no, content);
  if (repeatedLineRatio(chapter.text) > 0.08 || tooSimilarToPrior(chapter.text, prior)) {
    content = await callAi(args, buildMessages("上一次草稿重复度过高。请彻底重写：换场景、换冲突对象、换开场、换反转，不保留原段落。"), 0.9);
    chapter = normalizeChapterText(args, no, content);
  }
  if (options.skipQualityGate) return chapter;
  return chapter;
}

function plannedArchitecture(args) {
  return normalize([
    `《${args.title}》总设定`,
    "",
    `生产流程：${PIPELINE_TEXT}`,
    "",
    "作品定位：东方玄幻男频爽文，核心承诺是底层主角把嘲讽和建议变成可执行任务，用行动兑现所有人认为不可能的牛。",
    "世界规则：宗门、王朝、仙门和旧神残魂共同构成压迫秩序；力量来自修炼、资源、传承和代价交换，越高阶的改命越容易被旧秩序察觉。",
    "人物驱动：主角不是等系统喂饭的人，他必须主动接话、立约、冒险、布局，把外界压力变成自己的上升路径。",
    "长线结构：外门逆袭、内门争锋、王朝开局、仙门战争、诸天清算层层扩大，每一卷都兑现一个早期承诺，同时抛出更大代价。",
    "单元冲突：每20章围绕一个明确目标推进，目标失败会付出可见代价，目标成功必须改变人物关系或世界认知。",
    "章节任务：每章必须先有场景、冲突对象、主角选择、爽点兑现或信息变化、结尾钩子。",
    "",
    `类型：${args.genre}`,
    `目标读者：${args.audience}`,
    `核心创意：${args.premise}`,
    "",
    "一句话卖点：底层小人物把所有嘲讽、建议和吹过的牛变成系统任务，越被人看轻，兑现后的反击越狠。",
    "主角欲望：先活下去，再掌控自己的命运，最后建立一套不靠出身和血脉决定生死的新秩序。",
    "系统规则：听见明确建议、嘲讽或承诺后生成任务；任务必须通过行动完成，不能空领奖励；越离谱的承诺，兑现代价越大。",
    "爽点节奏：开局被辱，立刻触发任务；小目标当天兑现；中目标跨章兑现；大牛埋成卷末爆点。",
    "前期对手：外门师兄、执事堂、内门天才、宗门执法长老。",
    "中期对手：王朝供奉、仙门盟约、旧神残魂。",
    "长线秘密：系统并非外挂，而是上一纪元失败者留下的命运清算器。它选择主角，不是因为主角天命所归，而是因为主角最会把不公变成行动。",
  ].join("\r\n"));
}

function plannedBlueprint(args) {
  const rows = [];
  const totalUnits = Math.ceil(args.chapters / 20);
  rows.push("前10章逐章细纲");
  for (let i = 1; i <= Math.min(10, args.chapters); i++) {
    rows.push([
      `第${i}章 ${plannedTitle(i)}`,
      `功能：${i === 1 ? "开局受辱并触发系统" : i === 2 ? "第一次兑现建议" : i === 5 ? "小高潮，公开反打" : "推进任务链，扩大压力"}`,
      "场景：外门演武场、杂役院、执事堂之间切换。",
      "冲突：主角被要求完成不可能任务，旁人等着看笑话。",
      "反转：建议被系统判定为任务，主角用行动兑现。",
      "钩子：更大的建议或更危险的牛被抛出。",
    ].join("\r\n"));
  }
  rows.push("\r\n分卷单元纲");
  for (let unit = 1; unit <= totalUnits; unit++) {
    const start = (unit - 1) * 20 + 1;
    const end = Math.min(args.chapters, start + 19);
    rows.push([
      `第${start}-${end}章`,
      `单元目标：${unitTheme(unit)}`,
      `主要冲突：${unitConflict(unit)}`,
      `关键反转：主角兑现一个旁人认为绝不可能的承诺，并暴露更大危机。`,
      `结尾钩子：${unitHook(unit)}`,
    ].join("\r\n"));
  }
  return normalize(rows.join("\r\n\r\n"));
}

function plannedTitle(n) {
  const titles = ["这建议我听了", "一夜破境", "执事堂验身", "他们等我出丑", "当众兑现", "第二个建议", "杂役院翻天", "榜前留名", "内门来人", "牛吹大了"];
  return titles[(n - 1) % titles.length];
}

function unitTheme(unit) {
  if (unit <= 3) return "外门逆袭，建立听劝系统的基本爽点。";
  if (unit <= 8) return "内门争锋，主角用兑现承诺压过天才血脉。";
  if (unit <= 18) return "宗门与王朝线打开，系统代价开始显露。";
  if (unit <= 40) return "仙门战争，主角把个人逆袭变成势力崛起。";
  return "诸天清算，揭开系统来源并重建秩序。";
}

function unitConflict(unit) {
  if (unit <= 3) return "外门师兄和执事堂不断提出羞辱性建议。";
  if (unit <= 8) return "内门天才把主角当成垫脚石，逼他接下公开赌约。";
  if (unit <= 18) return "王朝和宗门高层发现系统痕迹，开始围猎主角。";
  if (unit <= 40) return "旧神残魂借建议任务设局，让主角每次变强都付出代价。";
  return "诸天旧秩序要收回所有被主角改写的命运。";
}

function unitHook(unit) {
  if (unit <= 3) return "主角吹出第一个大牛：三月内入内门前三。";
  if (unit <= 8) return "内门长老发现主角的任务奖励不是灵根，而是改命痕迹。";
  if (unit <= 18) return "系统第一次发布失败惩罚，证明它不是白送外挂。";
  if (unit <= 40) return "主角建立自己的势力，却发现每个追随者都会成为任务代价的一部分。";
  return "系统要求主角兑现最后一个牛：让诸天从此听底层人的劝。";
}

function plannedSampleChapter(args, no) {
  const title = `第${no}章 ${plannedTitle(no)}`;
  const advice = no % 2 === 0 ? "你要真有本事，明天就进外门前三" : "你这种资质，一辈子也突破不了肉身境";
  const scene = no <= 3 ? "外门演武场" : no <= 6 ? "执事堂" : "杂役院后山";
  const paragraphs = [
    title,
    "",
    `${scene}的钟声刚落，所有人的目光都落在林照尘身上。昨日他还是杂役院里最不起眼的人，连领一份淬体汤都要排在最后，今日却被执事点名上台验身。`,
    `台下有人压低声音笑道：“${advice}。”笑声很快传开，像一把把细小的刀，从人群里递出来，等着看他怎么退。`,
    "林照尘没有退。他脑海里那道冷冰冰的声音同时响起：检测到有效建议，任务已生成。任务要求，正面回应建议，并在众目睽睽下完成第一段兑现。",
    "他抬眼看向说话的人，忽然觉得这世上的恶意也不是全无用处。至少从现在开始，每一句看不起他的话，都可能变成他往上爬的台阶。",
    "执事把测验石推到他面前，语气不耐：“手放上去。若还是凡骨，就自己滚回杂役院。”",
    "林照尘把手按下。第一息，测验石毫无反应。台下笑声更响。第二息，石面浮出一道细纹。第三息，整块测验石忽然亮起赤金色的光，光芒顺着他的手腕往上爬，像一条刚醒的龙。",
    "执事脸色变了。方才说话的师兄也站了起来，眼底的轻慢被惊疑取代。",
    "林照尘收回手，掌心还残着灼痛。他没有装作无事，只认真看向那名师兄：“刚才那句建议，我听了。还有吗？”",
    "系统提示再次弹出：新的建议正在收集。当前可兑现目标，外门前三。",
    "林照尘知道，真正麻烦的不是今天赢了多少人，而是从这一刻开始，所有人都会想试试他到底能听多少劝。可他也正等着他们开口。",
  ];
  let text = normalize(paragraphs.join("\r\n\r\n"));
  while (countChars(text) < args.minWords) {
    text = normalize(text + "\r\n夜色落下时，林照尘独自回到杂役院。他没有因为白日的惊呼而松懈，反而把每一句嘲讽都写在墙上。那些字像伤口，也像路标。明日谁再开口，他就把谁的话变成新的任务。");
  }
  return { title: plannedTitle(no), text, summary: `第${no}章，林照尘借建议触发任务，在公开场合完成一次反击。` };
}

function normalizeChapterText(args, no, text, options = {}) {
  const lines = normalize(text).split(/\r?\n/).filter((line, index) => index > 0 || line.trim());
  let first = lines[0] || `第${no}章 ${plannedTitle(no)}`;
  if (!/^第.+章/.test(first)) first = `第${no}章 ${first.replace(/^#+\s*/, "").trim() || plannedTitle(no)}`;
  const title = first.replace(/^第.+?章\s*/, "").trim() || plannedTitle(no);
  const body = normalize([first, "", ...lines.slice(1)].join("\r\n"));
  if (countChars(body) < Math.max(400, Math.floor(args.minWords * 0.6))) {
    if (options.fallback) return plannedSampleChapter(args, no);
    throw new Error(`第 ${no} 章 AI 返回正文过短`);
  }
  return { title, text: body, summary: `${title}：完成本章冲突并留下下一章钩子。` };
}

function writeState(statePath, state) {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
}

function saveNeedsRepairChapter(bookDir, args, no, chapter, reports, reason) {
  const repairDir = path.join(bookDir, "_needs_repair");
  ensureDir(repairDir);
  const prefix = String(no).padStart(3, "0");
  const base = `${prefix}-第${no}章 ${safeName(chapter.title)}`;
  const draftPath = path.join(repairDir, `${base}.txt`);
  const reportPath = path.join(repairDir, `${base}.quality.json`);
  const instructionPath = path.join(repairDir, `${base}-修复指令.txt`);
  const last = reports.at(-1) || {};
  fs.writeFileSync(draftPath, chapter.text, "utf8");
  fs.writeFileSync(reportPath, JSON.stringify({
    no,
    title: chapter.title,
    passed: false,
    blocked: true,
    reason,
    reports,
    pipeline: PIPELINE_TEXT,
    checkedAt: new Date().toISOString(),
  }, null, 2), "utf8");
  fs.writeFileSync(instructionPath, normalize([
    `第 ${no} 章进入待修复队列。`,
    "",
    `失败原因：${reason}`,
    "",
    "下一步自动化动作：",
    "1. 保留当前草稿，不进入正式 chapters 目录。",
    "2. 根据下方问题重新生成本章。",
    "3. 本章通过后，再继续生成后续章节，避免后文接在错误版本上。",
    "",
    "质检问题：",
    ...(last.issues || []).map((item) => `- ${item}`),
    "",
    "重写指令：",
    last.rewriteInstruction || "重写本章，确保章节任务完成、人物口吻连贯、世界规则一致、结尾有钩子。",
    "",
    `目标字数：${wordRangeText(args)}`,
  ].join("\r\n")), "utf8");
  return { no, draftPath, reportPath, instructionPath, reason };
}

async function writeNovel(args) {
  if (args.action === "batch") return writeNextBatch(args);

  const bookDir = uniqueDir(args.outputRoot, args.title);
  ensureDir(path.join(bookDir, "chapters"));
  const statePath = path.join(bookDir, "generation_state.json");

  let engineUsed = args.engine;
  let note = "";
  let architecture = "";
  let blueprint = "";
  const generated = [];
  const targetWriteChapters = sampleChapterCount(args);

  writeState(statePath, {
    title: args.title,
    genre: args.genre,
    premise: args.premise,
    audience: args.audience,
    plannedChapters: args.chapters,
    targetWriteChapters,
    words: args.minWords,
    minWords: args.minWords,
    maxWords: args.maxWords,
    engine: "starting",
    model: args.engine === "ai" ? aiConfig(args).model : "",
    output: bookDir,
    status: "starting",
    generatedAt: new Date().toISOString(),
  });

  try {
    if (args.engine === "ai" && shouldPlanOnly(args)) {
      engineUsed = "plan-and-sample";
      note = `规划章节数 ${args.chapters} 较大，本次只生成全书规划和前 ${targetWriteChapters} 章样章，避免批量灌水正文。`;
      architecture = plannedArchitecture(args);
      blueprint = plannedBlueprint(args);
    } else if (args.engine === "ai") {
      architecture = await aiArchitecture(args);
      blueprint = await aiBlueprint(args, architecture);
    } else {
      engineUsed = "plan-and-sample";
      note = `模板备用只生成规划和前 ${targetWriteChapters} 章样章，不批量灌水。`;
      architecture = plannedArchitecture(args);
      blueprint = plannedBlueprint(args);
    }
  } catch (error) {
    if (args.engine === "ai" && !isLocalAi(args)) {
      throw new Error(`云端 AI 生成失败，已停止，未使用模板伪生成：${error.message || error}`);
    }
    engineUsed = "plan-and-sample";
    note = `AI 生成失败，已切换为规划和样章模式：${error.message || error}`;
    architecture = plannedArchitecture(args);
    blueprint = plannedBlueprint(args);
  }

  fs.writeFileSync(path.join(bookDir, "00-总设定.txt"), architecture, "utf8");
  fs.writeFileSync(path.join(bookDir, "01-章纲.txt"), blueprint, "utf8");
  fs.writeFileSync(path.join(bookDir, "00-故事生产系统.txt"), normalize([
    `《${args.title}》故事生产系统`,
    "",
    PIPELINE_TEXT,
    "",
    "使用规则：先确认作品定位、世界规则、人物驱动和长线结构能支撑长篇，再进入单元冲突和章节任务；每章正文保存前必须做连贯性校验和节奏优化。",
    "",
    architecture,
  ].join("\r\n")), "utf8");

  writeState(statePath, {
    title: args.title,
    genre: args.genre,
    premise: args.premise,
    audience: args.audience,
    plannedChapters: args.chapters,
    targetWriteChapters,
    words: args.minWords,
    minWords: args.minWords,
    maxWords: args.maxWords,
    engine: engineUsed,
    model: args.engine === "ai" ? aiConfig(args).model : "",
    output: bookDir,
    status: "writing-samples",
    note,
    generatedAt: new Date().toISOString(),
    summaries: [],
  });

  for (let no = 1; no <= targetWriteChapters; no++) {
    let chapter;
    let qualityReports = [];
    try {
      chapter = engineUsed === "ai" ? await aiChapter(args, architecture, blueprint, generated, no) : plannedSampleChapter(args, no);
      if (engineUsed === "ai") {
        const checked = await checkAndRewriteChapter(args, architecture, blueprint, generated, no, chapter);
        chapter = checked.chapter;
        qualityReports = checked.reports;
        if (checked.blocked) {
          const blocked = saveNeedsRepairChapter(bookDir, args, no, chapter, qualityReports, checked.reason);
          writeState(statePath, {
            title: args.title,
            genre: args.genre,
            premise: args.premise,
            audience: args.audience,
            plannedChapters: args.chapters,
            generatedChapters: generated.length,
            targetWriteChapters,
            words: args.minWords,
            minWords: args.minWords,
            maxWords: args.maxWords,
            engine: engineUsed,
            model: args.engine === "ai" ? aiConfig(args).model : "",
            output: bookDir,
            status: "needs-repair",
            blockedChapter: blocked,
            note: "章节质量未通过，已进入待修复队列，正式正文未被覆盖。",
            updatedAt: new Date().toISOString(),
            summaries: generated,
          });
          throw new Error(`${checked.reason}。已保存待修复草稿：${blocked.draftPath}`);
        }
      }
    } catch (error) {
      if (args.engine === "ai" && !isLocalAi(args)) {
        throw new Error(`第 ${no} 章云端 AI 生成失败，已停止，未使用模板伪生成：${error.message || error}`);
      }
      note = note || `第 ${no} 章 AI 生成失败，已使用样章备用：${error.message || error}`;
      chapter = plannedSampleChapter(args, no);
      if (engineUsed === "ai") engineUsed = "mixed-sample";
    }
    const dir = chapterDir(bookDir, no);
    ensureDir(dir);
    const file = path.join(dir, `${String(no).padStart(3, "0")}-第${no}章 ${safeName(chapter.title)}.txt`);
    fs.writeFileSync(file, chapter.text, "utf8");
    fs.writeFileSync(file.replace(/\.txt$/, ".quality.json"), JSON.stringify({
      no,
      title: chapter.title,
      passed: qualityReports.length ? Boolean(qualityReports.at(-1).pass) : true,
      reports: qualityReports,
      pipeline: PIPELINE_TEXT,
      checkedAt: new Date().toISOString(),
    }, null, 2), "utf8");
    generated.push({
      no,
      title: chapter.title,
      summary: chapter.summary,
      opening: chapter.text.replace(/\s/g, "").slice(0, 120),
      qualityScore: qualityReports.at(-1)?.score || null,
    });
    writeState(statePath, {
      title: args.title,
      genre: args.genre,
      premise: args.premise,
      audience: args.audience,
      plannedChapters: args.chapters,
      generatedChapters: generated.length,
      targetWriteChapters,
      words: args.minWords,
      minWords: args.minWords,
      maxWords: args.maxWords,
      engine: engineUsed,
      model: args.engine === "ai" ? aiConfig(args).model : "",
      output: bookDir,
      status: "writing-samples",
      note,
      generatedAt: new Date().toISOString(),
      summaries: generated,
    });
    console.log(`已生成第 ${no} 章：${chapter.title}`);
    if (qualityReports.length) console.log(`第 ${no} 章质量校验通过，分数：${qualityReports.at(-1).score}`);
  }

  writeState(statePath, {
    title: args.title,
    genre: args.genre,
    premise: args.premise,
    audience: args.audience,
    plannedChapters: args.chapters,
    generatedChapters: generated.length,
    targetWriteChapters,
    words: args.minWords,
    minWords: args.minWords,
    maxWords: args.maxWords,
    engine: engineUsed,
    model: args.engine === "ai" ? aiConfig(args).model : "",
    output: bookDir,
    status: "completed",
    note,
    generatedAt: new Date().toISOString(),
    summaries: generated,
  });

  fs.writeFileSync(path.join(bookDir, "02-生成说明.txt"), normalize([
    `已生成《${args.title}》项目包。`,
    `规划章节：${args.chapters}`,
    `本次正文样章：${generated.length}`,
    `引擎：${engineUsed}`,
    note,
    "",
    "说明：大长篇不能一次性批量生成正文，否则质量会严重下降。建议确认总设定和前几章样章后，再按每批 5-10 章继续精写。",
    "高质量流程：作品定位 → 世界规则 → 人物驱动 → 长线结构 → 单元冲突 → 章节任务 → 正文表达 → 连贯性校验 → 节奏优化。",
    `目录：${bookDir}`,
  ].filter(Boolean).join("\r\n")), "utf8");
  return bookDir;
}

async function writeNextBatch(args) {
  const bookDir = latestProjectDir(args.outputRoot, args.title);
  if (!bookDir) throw new Error(`没有找到《${args.title}》项目包，请先生成项目包。`);

  const architecturePath = path.join(bookDir, "00-总设定.txt");
  const blueprintPath = path.join(bookDir, "01-章纲.txt");
  const statePath = path.join(bookDir, "generation_state.json");
  if (!fs.existsSync(architecturePath) || !fs.existsSync(blueprintPath)) {
    throw new Error("项目包缺少总设定或章纲，请先重新生成项目包。");
  }

  const architecture = fs.readFileSync(architecturePath, "utf8");
  const blueprint = fs.readFileSync(blueprintPath, "utf8");
  const oldState = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : {};
  const summaries = Array.isArray(oldState.summaries) ? oldState.summaries : [];
  const start = latestChapterNo(bookDir) + 1;
  const end = Math.min(args.chapters, start + args.batchSize - 1);
  if (start > args.chapters) {
    console.log("已达到规划章节数，没有新的章节需要生成。");
    return bookDir;
  }

  writeState(statePath, {
    ...oldState,
    title: args.title,
    plannedChapters: args.chapters,
    status: "writing-batch",
    minWords: args.minWords,
    maxWords: args.maxWords,
    currentBatch: { start, end },
    updatedAt: new Date().toISOString(),
  });

  const generated = [];
  for (let no = start; no <= end; no++) {
    let chapter;
    let qualityReports = [];
    if (args.engine === "template") {
      chapter = plannedSampleChapter(args, no);
    } else {
      chapter = await aiChapter(args, architecture, blueprint, summaries.concat(generated), no);
      const checked = await checkAndRewriteChapter(args, architecture, blueprint, summaries.concat(generated), no, chapter);
      chapter = checked.chapter;
      qualityReports = checked.reports;
      if (checked.blocked) {
        const blocked = saveNeedsRepairChapter(bookDir, args, no, chapter, qualityReports, checked.reason);
        writeState(statePath, {
          ...oldState,
          title: args.title,
          plannedChapters: args.chapters,
          generatedChapters: start - 1 + generated.length,
          words: args.minWords,
          minWords: args.minWords,
          maxWords: args.maxWords,
          engine: "ai-batch",
          model: aiConfig(args).model,
          output: bookDir,
          status: "needs-repair",
          currentBatch: { start, end },
          blockedChapter: blocked,
          note: "章节质量未通过，已进入待修复队列，正式正文未被覆盖。",
          updatedAt: new Date().toISOString(),
          summaries: summaries.concat(generated),
        });
        throw new Error(`${checked.reason}。已保存待修复草稿：${blocked.draftPath}`);
      }
    }
    const dir = chapterDir(bookDir, no);
    ensureDir(dir);
    const file = path.join(dir, `${String(no).padStart(3, "0")}-第${no}章 ${safeName(chapter.title)}.txt`);
    fs.writeFileSync(file, chapter.text, "utf8");
    fs.writeFileSync(file.replace(/\.txt$/, ".quality.json"), JSON.stringify({
      no,
      title: chapter.title,
      passed: qualityReports.length ? Boolean(qualityReports.at(-1).pass) : true,
      reports: qualityReports,
      pipeline: PIPELINE_TEXT,
      checkedAt: new Date().toISOString(),
    }, null, 2), "utf8");
    generated.push({
      no,
      title: chapter.title,
      summary: chapter.summary,
      opening: chapter.text.replace(/\s/g, "").slice(0, 120),
      qualityScore: qualityReports.at(-1)?.score || null,
    });
    writeState(statePath, {
      ...oldState,
      title: args.title,
      plannedChapters: args.chapters,
      generatedChapters: no,
      words: args.minWords,
      minWords: args.minWords,
      maxWords: args.maxWords,
      engine: args.engine === "template" ? "template-batch" : "ai-batch",
      model: args.engine === "ai" ? aiConfig(args).model : "",
      output: bookDir,
      status: "writing-batch",
      currentBatch: { start, end },
      updatedAt: new Date().toISOString(),
      summaries: summaries.concat(generated),
    });
    console.log(`已生成第 ${no} 章：${chapter.title}`);
    if (qualityReports.length) console.log(`第 ${no} 章质量校验通过，分数：${qualityReports.at(-1).score}`);
  }

  writeState(statePath, {
    ...oldState,
    title: args.title,
    plannedChapters: args.chapters,
    generatedChapters: end,
    words: args.minWords,
    minWords: args.minWords,
    maxWords: args.maxWords,
    engine: args.engine === "template" ? "template-batch" : "ai-batch",
    model: args.engine === "ai" ? aiConfig(args).model : "",
    output: bookDir,
    status: "completed",
    lastBatch: { start, end },
    updatedAt: new Date().toISOString(),
    summaries: summaries.concat(generated),
  });

  fs.appendFileSync(path.join(bookDir, "02-生成说明.txt"), normalize([
    "",
    `追加生成：第 ${start}-${end} 章`,
    `时间：${new Date().toISOString()}`,
    `引擎：${args.engine === "template" ? "template-batch" : "ai-batch"}`,
    `流程：${PIPELINE_TEXT}`,
  ].join("\r\n")), "utf8");
  return bookDir;
}

(async () => {
  try {
    const args = parseArgs(process.argv);
    console.log(`开始生成《${args.title}》`);
    console.log(`动作：${args.action}；引擎：${args.engine}；类型：${args.genre}；规划章节：${args.chapters}；目标字数：${wordRangeText(args)}`);
    const output = await writeNovel(args);
    console.log(`生成完成：${output}`);
  } catch (error) {
    console.error(error.stack || error.message || String(error));
    process.exit(1);
  }
})();
