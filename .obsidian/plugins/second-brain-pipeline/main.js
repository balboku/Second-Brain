const crypto = require("crypto");
const { Plugin, Notice, PluginSettingTab, Setting, Modal, TFile, normalizePath } = require("obsidian");

const PLUGIN_ID = "second-brain-pipeline";
const GENERATED_BY = "second-brain-pipeline";
const COMPILE_PROFILE_VERSION = "zh-hant-v2";
const TEXT_EXTENSIONS = new Set([
  "md",
  "markdown",
  "txt",
  "json",
  "csv",
  "tsv",
  "js",
  "cjs",
  "mjs",
  "ts",
  "tsx",
  "jsx",
  "py",
  "rb",
  "go",
  "java",
  "rs",
  "sh",
  "yaml",
  "yml",
  "toml",
  "ini",
  "cfg",
  "html",
  "css",
  "xml",
  "sql",
]);

const DEFAULT_SETTINGS = {
  geminiApiKey: "",
  geminiModel: "gemini-2.5-flash",
  geminiEmbeddingModel: "gemini-embedding-2-preview",
  temperature: 0.2,
  maxContextChars: 120000,
  maxOutputTokens: 4096,
  retryCount: 3,
  retryBaseDelayMs: 2000,
  pdfInlineMaxBytes: 10 * 1024 * 1024,
  rawFolder: "raw",
  stagingFolder: "staging",
  wikiFolder: "wiki",
  conceptsFolder: "wiki/概念",
  articlesFolder: "wiki/articles",
  queriesFolder: "wiki/queries",
  lintFolder: "wiki/lint",
  queryQueuePath: "system/queue/_queue.md",
  autoStageTextFiles: true,
  includeRawWhenStagingEmpty: true,
  enableAutoFix: false,
  compileCache: {},
  embeddingsCache: {},
};

const COMPILE_SCHEMA = {
  type: "object",
  properties: {
    article_title: {
      type: "string",
      description: "The cleaned title of the source article or document.",
    },
    article_summary: {
      type: "string",
      description: "A concise 1-2 paragraph summary of the source.",
    },
    concept_notes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          summary: { type: "string" },
          body: {
            type: "string",
            description: "Markdown body for the concept note.",
          },
          related_concepts: {
            type: "array",
            items: { type: "string" },
          },
          tags: {
            type: "array",
            items: { type: "string" },
          },
        },
        required: ["title", "summary", "body", "related_concepts", "tags"],
      },
    },
    new_glossary_mappings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          non_standard: { type: "string", description: "The incorrect, alternate, or foreign term encountered in the text." },
          standard: { type: "string", description: "The standardized central concept name." }
        },
        required: ["non_standard", "standard"]
      }
    }
  },
  required: ["article_title", "article_summary", "concept_notes", "new_glossary_mappings"],
};

const QUERY_SCHEMA = {
  type: "object",
  properties: {
    answer_title: { type: "string" },
    answer_markdown: {
      type: "string",
      description: "The full markdown answer body.",
    },
    source_paths: {
      type: "array",
      items: { type: "string" },
    },
  },
  required: ["answer_title", "answer_markdown", "source_paths"],
};

const LINT_SCHEMA = {
  type: "object",
  properties: {
    overview: { type: "string" },
    issues: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: {
            type: "string",
            enum: ["high", "medium", "low"],
          },
          title: { type: "string" },
          details: { type: "string" },
          file_path: { type: "string" },
          suggestion: { type: "string" },
        },
        required: ["severity", "title", "details", "file_path", "suggestion"],
      },
    },
    new_connections: {
      type: "array",
      items: {
        type: "object",
        properties: {
          from: { type: "string" },
          to: { type: "string" },
          rationale: { type: "string" },
        },
        required: ["from", "to", "rationale"],
      },
    },
    new_glossary_mappings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          non_standard: { type: "string", description: "The incorrect, alternate, or foreign term encountered." },
          standard: { type: "string", description: "The standardized central concept name." }
        },
        required: ["non_standard", "standard"]
      }
    }
  },
  required: ["overview", "issues", "new_connections", "new_glossary_mappings"],
};

function cleanPath(value) {
  const normalized = normalizePath(String(value || "").trim());
  return normalized === "." ? "" : normalized.replace(/^\/+|\/+$/g, "");
}

function joinPath(...parts) {
  return cleanPath(parts.filter(Boolean).join("/"));
}

function parentPath(path) {
  const normalized = cleanPath(path);
  const index = normalized.lastIndexOf("/");
  return index === -1 ? "" : normalized.slice(0, index);
}

function basename(path) {
  const normalized = cleanPath(path);
  const index = normalized.lastIndexOf("/");
  return index === -1 ? normalized : normalized.slice(index + 1);
}

function extname(path) {
  const base = basename(path);
  const index = base.lastIndexOf(".");
  return index === -1 ? "" : base.slice(index + 1).toLowerCase();
}

function stemname(path) {
  const base = basename(path);
  const index = base.lastIndexOf(".");
  return index === -1 ? base : base.slice(0, index);
}

function notePathFromFilePath(path) {
  const dir = parentPath(path);
  const stem = stemname(path);
  return dir ? joinPath(dir, stem) : stem;
}

function sanitizeFileName(name) {
  const safe = String(name || "untitled")
    .replace(/[\\/:*?"<>|#^[\]{}]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (safe || "untitled").slice(0, 120);
}

function yamlQuote(value) {
  return JSON.stringify(String(value == null ? "" : value));
}

function renderArrayField(key, values) {
  const items = Array.from(new Set((values || []).map((item) => String(item || "").trim()).filter(Boolean)));
  if (!items.length) {
    return `${key}: []`;
  }
  return `${key}:\n${items.map((item) => `  - ${yamlQuote(item)}`).join("\n")}`;
}

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timestampSlug() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

function truncateText(text, limit) {
  if (!text || text.length <= limit) {
    return text || "";
  }
  return `${text.slice(0, limit)}\n\n[TRUNCATED AT ${limit} CHARACTERS]`;
}

function makeWikiLink(path, label = "") {
  const target = cleanPath(path);
  if (!target) {
    return String(label || "").trim();
  }
  const trimmedLabel = String(label || "").trim();
  return trimmedLabel ? `[[${target}|${trimmedLabel}]]` : `[[${target}]]`;
}

function normalizeLookupKey(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseLooseJson(text) {
  if (!text) {
    throw new Error("Gemini returned an empty response.");
  }
  const trimmed = String(text).trim();
  const directAttempts = [
    trimmed,
    trimmed.replace(/^```json\s*/i, "").replace(/```$/i, "").trim(),
    trimmed.replace(/^```\s*/i, "").replace(/```$/i, "").trim(),
  ];
  for (const attempt of directAttempts) {
    try {
      return JSON.parse(attempt);
    } catch (_) {}
  }
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
  }
  throw new Error("Could not parse Gemini JSON response.");
}

function extractWikilinks(markdown) {
  const matches = [];
  const regex = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;
  let match;
  while ((match = regex.exec(markdown)) !== null) {
    const target = String(match[1] || "").trim();
    if (target) {
      matches.push(target);
    }
  }
  return matches;
}

function toBase64(binary) {
  if (typeof Buffer === "undefined") {
    throw new Error("Buffer is not available in this runtime.");
  }
  if (binary instanceof Uint8Array) {
    return Buffer.from(binary).toString("base64");
  }
  if (binary instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(binary)).toString("base64");
  }
  if (ArrayBuffer.isView(binary)) {
    return Buffer.from(binary.buffer, binary.byteOffset, binary.byteLength).toString("base64");
  }
  return Buffer.from(binary).toString("base64");
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

class TextPromptModal extends Modal {
  constructor(app, options) {
    super(app);
    this.options = options;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: this.options.title });

    const textarea = contentEl.createEl("textarea");
    textarea.rows = 10;
    textarea.style.width = "100%";
    textarea.placeholder = this.options.placeholder || "";
    textarea.value = this.options.value || "";
    textarea.focus();

    const buttonRow = contentEl.createDiv();
    buttonRow.style.marginTop = "1rem";
    buttonRow.style.display = "flex";
    buttonRow.style.gap = "0.5rem";

    const runButton = buttonRow.createEl("button", { text: this.options.submitLabel || "Run" });
    runButton.addClass("mod-cta");
    const cancelButton = buttonRow.createEl("button", { text: "Cancel" });

    const submit = () => {
      const value = textarea.value.trim();
      if (!value) {
        new Notice("Please enter a value first.");
        return;
      }
      this.close();
      this.options.onSubmit(value);
    };

    runButton.addEventListener("click", submit);
    cancelButton.addEventListener("click", () => this.close());
    textarea.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        submit();
      }
    });
  }
}

class SecondBrainPipelinePlugin extends Plugin {
  async onload() {
    await this.loadEnv();
    await this.loadSettings();

    this.statusEl = this.addStatusBarItem();
    this.lastMainStatus = "💤 閒置";
    this.updateStatus(this.lastMainStatus);

    this.addSettingTab(new SecondBrainPipelineSettingTab(this.app, this));

    this.addCommand({
      id: "run-full-pipeline",
      name: "Second Brain Pipeline: Run full pipeline",
      callback: () => this.runSafely(() => this.runFullPipeline()),
    });

    this.addCommand({
      id: "run-phase-1-ingest",
      name: "Second Brain Pipeline: Run Phase 1 ingest",
      callback: () => this.runSafely(() => this.runPhase1()),
    });

    this.addCommand({
      id: "run-phase-2-compile",
      name: "Second Brain Pipeline: Run Phase 2 compile",
      callback: () => this.runSafely(() => this.runPhase2()),
    });

    this.addCommand({
      id: "run-phase-3-query",
      name: "Second Brain Pipeline: Run Phase 3 query",
      callback: () =>
        new TextPromptModal(this.app, {
          title: "Phase 3 Query",
          placeholder: "輸入你要讓系統回答並歸檔的問題",
          submitLabel: "Run Query",
          onSubmit: (value) => this.runSafely(() => this.runPhase3(value)),
        }).open(),
    });

    this.addCommand({
      id: "run-phase-3-queued-queries",
      name: "Second Brain Pipeline: Run queued queries",
      callback: () => this.runSafely(() => this.runQueuedQueries()),
    });

    this.addCommand({
      id: "run-phase-4-lint",
      name: "Second Brain Pipeline: Run Phase 4 lint",
      callback: () => this.runSafely(() => this.runPhase4()),
    });

    this.addCommand({
      id: "run-link-auto-fix",
      name: "Second Brain Pipeline: Run link auto-fix",
      callback: () => this.runSafely(() => this.runLinkAutoFix()),
    });
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  /**
   * Load environment variables from a .env file in the vault root.
   */
  async loadEnv() {
    try {
      const content = await this.readText(".env");
      if (!content) return;
      const lines = content.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const index = trimmed.indexOf("=");
        if (index === -1) continue;
        const key = trimmed.slice(0, index).trim();
        const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
        if (key && value && typeof process !== "undefined" && process.env) {
          process.env[key] = value;
        }
      }
    } catch (e) {
      console.warn("[second-brain-pipeline] Failed to load .env file:", e);
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async runSafely(task) {
    try {
      await task();
    } catch (error) {
      this.updateStatus("❌ 發生錯誤");
      console.error(`[${PLUGIN_ID}]`, error);
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Second Brain Pipeline failed: ${message}`, 10000);
    }
  }

  /**
   * Update the status bar item.
   * @param {string} text Main status text
   * @param {string} subStatus Optional progress or sub-task info
   */
  updateStatus(text, subStatus = "") {
    if (subStatus !== "🧠 Gemini 思考中...") {
      this.lastMainStatus = text;
    }
    const display = subStatus ? `Brain: ${text} (${subStatus})` : `Brain: ${text}`;
    this.statusEl.setText(display);
  }

  /**
   * Reset status to idle after a short delay.
   */
  clearStatus(finishedLabel = "✅ 已完成") {
    this.updateStatus(finishedLabel);
    setTimeout(() => this.updateStatus("💤 閒置"), 5000);
  }

  getApiKey() {
    const envKey =
      typeof process !== "undefined" && process?.env
        ? process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || ""
        : "";
    return String(this.settings.geminiApiKey || envKey || "").trim();
  }

  async ensureFolder(folderPath) {
    const normalized = cleanPath(folderPath);
    if (!normalized) {
      return;
    }
    const segments = normalized.split("/");
    let current = "";
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      if (!this.app.vault.getAbstractFileByPath(current)) {
        await this.app.vault.createFolder(current);
      }
    }
  }

  async writeText(path, content) {
    const normalized = cleanPath(path);
    await this.ensureFolder(parentPath(normalized));
    const existing = this.app.vault.getAbstractFileByPath(normalized);
    if (existing instanceof TFile) {
      const current = await this.app.vault.cachedRead(existing);
      if (current === content) {
        return existing.path;
      }
      await this.app.vault.modify(existing, content);
      return existing.path;
    }
    const created = await this.app.vault.create(normalized, content);
    return created.path;
  }

  async readText(path) {
    const file = this.app.vault.getAbstractFileByPath(cleanPath(path));
    if (!(file instanceof TFile)) {
      return "";
    }
    return this.app.vault.cachedRead(file);
  }

  async readGlossary() {
    const glossaryPath = "system/glossary.json";
    const content = await this.readText(glossaryPath);
    if (!content) return null;
    try {
      return JSON.parse(content);
    } catch (e) {
      console.warn("[second-brain-pipeline] Failed to parse glossary.json:", e);
      return null;
    }
  }

  async writeGlossary(glossaryObj) {
    const glossaryPath = "system/glossary.json";
    await this.writeText(glossaryPath, JSON.stringify(glossaryObj, null, 2));
  }

  async mergeGlossaryMappings(newMappings) {
    if (!newMappings || newMappings.length === 0) return;
    const glossary = (await this.readGlossary()) || { mappings: {} };
    if (!glossary.mappings) glossary.mappings = {};

    let addedCount = 0;
    for (const item of newMappings) {
      if (item.non_standard && item.standard) {
        // Only add if not already present with same standard
        if (glossary.mappings[item.non_standard] !== item.standard) {
          glossary.mappings[item.non_standard] = item.standard;
          addedCount++;
        }
      }
    }

    if (addedCount > 0) {
      await this.writeGlossary(glossary);
      new Notice(`Glossary updated: added ${addedCount} new mappings.`);
    }
  }

  validateContent(content) {
    if (!content || content.trim().length === 0) {
      return { valid: false, reason: "Content is empty" };
    }
    if (!content.trimStart().startsWith("---")) {
      return { valid: false, reason: "Missing YAML Frontmatter" };
    }
    return { valid: true };
  }

  calculateSimilarity(s1, s2) {
    let longer = s1;
    let shorter = s2;
    if (s1.length < s2.length) {
      longer = s2;
      shorter = s1;
    }
    const longerLength = longer.length;
    if (longerLength === 0) {
      return 1.0;
    }
    return (longerLength - this.editDistance(longer, shorter)) / parseFloat(longerLength);
  }

  editDistance(s1, s2) {
    s1 = s1.toLowerCase();
    s2 = s2.toLowerCase();
    const costs = [];
    for (let i = 0; i <= s1.length; i++) {
      let lastValue = i;
      for (let j = 0; j <= s2.length; j++) {
        if (i === 0) costs[j] = j;
        else {
          if (j > 0) {
            let newValue = costs[j - 1];
            if (s1.charAt(i - 1) !== s2.charAt(j - 1))
              newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
            costs[j - 1] = lastValue;
            lastValue = newValue;
          }
        }
      }
      if (i > 0) costs[s2.length] = lastValue;
    }
    return costs[s2.length];
  }

  async readBinary(file) {
    const binary = await this.app.vault.readBinary(file);
    if (binary instanceof Uint8Array) {
      return binary;
    }
    if (binary instanceof ArrayBuffer) {
      return new Uint8Array(binary);
    }
    if (ArrayBuffer.isView(binary)) {
      return new Uint8Array(binary.buffer, binary.byteOffset, binary.byteLength);
    }
    return new Uint8Array(binary);
  }

  async resolveWritableGeneratedPath(desiredPath) {
    const normalized = cleanPath(desiredPath);
    const existing = this.app.vault.getAbstractFileByPath(normalized);
    if (!(existing instanceof TFile)) {
      return normalized;
    }
    const current = await this.app.vault.cachedRead(existing);
    if (current.includes(`generated_by: ${yamlQuote(GENERATED_BY)}`) || current.includes(`generated_by: ${GENERATED_BY}`)) {
      return normalized;
    }
    const folder = parentPath(normalized);
    const ext = extname(normalized);
    const stem = stemname(normalized);
    return joinPath(folder, `${sanitizeFileName(stem)} ${timestampSlug()}.${ext || "md"}`);
  }

  async writeGeneratedFile(desiredPath, content) {
    const actualPath = await this.resolveWritableGeneratedPath(desiredPath);
    await this.writeText(actualPath, content);
    return actualPath;
  }

  getAllFilesUnder(folderPath) {
    const start = this.app.vault.getAbstractFileByPath(cleanPath(folderPath));
    if (!start) {
      return [];
    }
    const files = [];
    const stack = [start];
    while (stack.length) {
      const current = stack.pop();
      if (!current) {
        continue;
      }
      if (current instanceof TFile) {
        files.push(current);
        continue;
      }
      if (Array.isArray(current.children)) {
        for (const child of current.children) {
          stack.push(child);
        }
      }
    }
    return files;
  }

  isTextFile(file) {
    return TEXT_EXTENSIONS.has(extname(file.path));
  }

  isPdfFile(file) {
    return extname(file.path) === "pdf";
  }

  isSupportedCompileFile(file) {
    return this.isTextFile(file) || this.isPdfFile(file);
  }

  relativeTo(baseFolder, fullPath) {
    const base = cleanPath(baseFolder);
    const full = cleanPath(fullPath);
    if (!base) {
      return full;
    }
    if (full === base) {
      return "";
    }
    if (full.startsWith(`${base}/`)) {
      return full.slice(base.length + 1);
    }
    return basename(full);
  }

  async getWorkflowContext() {
    const paths = [
      "system/LLM知識庫系統.md",
      "system/Phases/Phase-1-Ingest.md",
      "system/Phases/Phase-2-Compile.md",
      "system/Phases/Phase-3-Query-Enhance.md",
      "system/Phases/Phase-4-Lint.md",
      "system/lint/系統檢查清單.md",
    ];
    const parts = [];
    for (const path of paths) {
      const content = await this.readText(path);
      if (content.trim()) {
        parts.push(`FILE: ${path}\n${content.trim()}`);
      }
    }
    return parts.join("\n\n---\n\n");
  }

  getCompileCache() {
    if (!this.settings.compileCache || typeof this.settings.compileCache !== "object") {
      this.settings.compileCache = {};
    }
    return this.settings.compileCache;
  }

  getCompileCacheEntry(sourcePath) {
    return this.getCompileCache()[cleanPath(sourcePath)] || null;
  }

  setCompileCacheEntry(sourcePath, entry) {
    this.getCompileCache()[cleanPath(sourcePath)] = entry;
  }

  removeCompileCacheEntry(sourcePath) {
    delete this.getCompileCache()[cleanPath(sourcePath)];
  }

  async prepareCompileSource(file) {
    if (this.isPdfFile(file)) {
      const bytes = await this.readBinary(file);
      return {
        sourceKind: "pdf",
        sourceText: "",
        bytes,
        fingerprint: `pdf:${sha256(bytes)}`,
      };
    }

    const sourceText = await this.app.vault.cachedRead(file);
    return {
      sourceKind: "text",
      sourceText,
      bytes: null,
      fingerprint: `text:${sha256(sourceText)}`,
    };
  }

  async isGeneratedFileOwnedBySource(path, sourcePath) {
    const file = this.app.vault.getAbstractFileByPath(cleanPath(path));
    if (!(file instanceof TFile)) {
      return false;
    }
    const content = await this.app.vault.cachedRead(file);
    const generatedMarker =
      content.includes(`generated_by: ${yamlQuote(GENERATED_BY)}`) || content.includes(`generated_by: ${GENERATED_BY}`);
    const sourceMarker = content.includes(`source_path: ${yamlQuote(sourcePath)}`);
    return generatedMarker && sourceMarker;
  }

  async isCompileEntryUpToDate(sourcePath, fingerprint) {
    const entry = this.getCompileCacheEntry(sourcePath);
    if (!entry || entry.fingerprint !== fingerprint) {
      return false;
    }
    if (entry.compileProfile !== COMPILE_PROFILE_VERSION) {
      return false;
    }
    if (!entry.articlePath || !(await this.isGeneratedFileOwnedBySource(entry.articlePath, sourcePath))) {
      return false;
    }
    const conceptPaths = Array.isArray(entry.conceptPaths) ? entry.conceptPaths : [];
    for (const conceptPath of conceptPaths) {
      if (!(await this.isGeneratedFileOwnedBySource(conceptPath, sourcePath))) {
        return false;
      }
    }
    return true;
  }

  async cleanupCompileOutputs(sourcePath, entry, retainedPaths = []) {
    if (!entry) {
      return;
    }
    const retained = new Set(retainedPaths.map((path) => cleanPath(path)).filter(Boolean));
    const outputPaths = Array.from(new Set([entry.articlePath, ...(entry.conceptPaths || [])].filter(Boolean)));
    for (const outputPath of outputPaths) {
      if (retained.has(cleanPath(outputPath))) {
        continue;
      }
      const file = this.app.vault.getAbstractFileByPath(cleanPath(outputPath));
      if (!(file instanceof TFile)) {
        continue;
      }
      if (await this.isGeneratedFileOwnedBySource(outputPath, sourcePath)) {
        await this.app.vault.delete(file, true);
      }
    }
  }

  isRetryableStatus(status) {
    return [408, 429, 500, 502, 503, 504].includes(status);
  }

  getRetryDelayMs(attempt, response) {
    const retryAfter = response?.headers?.get?.("retry-after");
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (!Number.isNaN(seconds) && seconds > 0) {
        return seconds * 1000;
      }
    }
    const base = Math.max(250, Number(this.settings.retryBaseDelayMs) || 2000);
    const jitter = Math.floor(Math.random() * 400);
    return base * Math.pow(2, Math.max(0, attempt - 1)) + jitter;
  }

  extractGeminiText(payload) {
    const blockReason = payload?.promptFeedback?.blockReason;
    if (blockReason) {
      throw new Error(`Gemini blocked the request: ${blockReason}`);
    }
    const candidate = payload?.candidates?.[0];
    const parts = candidate?.content?.parts || [];
    const text = parts.map((part) => part?.text || "").join("").trim();
    if (!text) {
      throw new Error("Gemini returned no text candidates.");
    }
    return text;
  }

  async postGemini(body) {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error("No Gemini API key found. Set it in plugin settings or GEMINI_API_KEY.");
    }
    const model = String(this.settings.geminiModel || "").trim();
    if (!model) {
      throw new Error("No Gemini model configured.");
    }
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const maxAttempts = Math.max(1, (Number(this.settings.retryCount) || 0) + 1);

    this.updateStatus(this.lastMainStatus || "🤖 執行中", "🧠 Gemini 思考中...");
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify(body),
      });

      if (response.ok) {
        this.updateStatus(this.lastMainStatus || "🤖 執行中");
        return response.json();
      }

      const text = await response.text();
      if (this.isRetryableStatus(response.status) && attempt < maxAttempts) {
        const delayMs = this.getRetryDelayMs(attempt, response);
        new Notice(`Gemini busy (${response.status}). Retrying in ${Math.ceil(delayMs / 1000)}s...`, 4000);
        await sleep(delayMs);
        continue;
      }

      throw new Error(`Gemini API ${response.status}: ${text}`);
    }
  }

  async requestText(systemInstruction, userPrompt) {
    return this.requestTextWithParts(systemInstruction, [{ text: userPrompt }]);
  }

  async requestTextWithParts(systemInstruction, userParts) {
    const payload = await this.postGemini({
      system_instruction: {
        parts: [{ text: systemInstruction }],
      },
      contents: [
        {
          parts: userParts,
        },
      ],
      generationConfig: {
        temperature: this.settings.temperature,
        maxOutputTokens: this.settings.maxOutputTokens,
      },
    });
    return this.extractGeminiText(payload);
  }

  async requestStructuredJson(systemInstruction, userPrompt, schema) {
    return this.requestStructuredJsonWithParts(systemInstruction, [{ text: userPrompt }], schema);
  }

  async requestStructuredJsonWithParts(systemInstruction, userParts, schema) {
    try {
      const payload = await this.postGemini({
        system_instruction: {
          parts: [{ text: systemInstruction }],
        },
        contents: [
          {
            parts: userParts,
          },
        ],
        generationConfig: {
          temperature: this.settings.temperature,
          maxOutputTokens: this.settings.maxOutputTokens,
          responseMimeType: "application/json",
          responseJsonSchema: schema,
        },
      });
      return parseLooseJson(this.extractGeminiText(payload));
    } catch (error) {
      const fallbackText = await this.requestTextWithParts(
        systemInstruction,
        [
          ...userParts,
          {
            text: "Return valid JSON only. Do not use code fences. The JSON must match the agreed schema exactly.",
          },
        ]
      );
      return parseLooseJson(fallbackText);
    }
  }

  renderGeneratedFrontmatter(fields) {
    const lines = ["---"];
    for (const [key, value] of Object.entries(fields)) {
      if (Array.isArray(value)) {
        lines.push(renderArrayField(key, value));
      } else {
        lines.push(`${key}: ${yamlQuote(value)}`);
      }
    }
    lines.push("---");
    return lines.join("\n");
  }

  resolveConceptTitle(title, knownTitles = []) {
    const candidate = sanitizeFileName(title);
    if (!candidate) {
      return "";
    }
    if (knownTitles.includes(candidate)) {
      return candidate;
    }
    const candidateKey = normalizeLookupKey(candidate);
    if (!candidateKey) {
      return "";
    }
    const exact = knownTitles.find((item) => normalizeLookupKey(item) === candidateKey);
    if (exact) {
      return exact;
    }
    return knownTitles.find((item) => {
      const itemKey = normalizeLookupKey(item);
      return itemKey && (itemKey.startsWith(candidateKey) || candidateKey.startsWith(itemKey));
    }) || "";
  }

  formatConceptReference(title, knownTitles = []) {
    const rawTitle = String(title || "").trim();
    if (!rawTitle) {
      return "None";
    }
    const resolvedTitle = this.resolveConceptTitle(rawTitle, knownTitles);
    if (!resolvedTitle) {
      return rawTitle;
    }
    const label = rawTitle === resolvedTitle ? "" : rawTitle;
    return makeWikiLink(joinPath(this.settings.conceptsFolder, resolvedTitle), label);
  }

  renderConceptReference(title, knownTitles = []) {
    return `- ${this.formatConceptReference(title, knownTitles)}`;
  }

  normalizeGeneratedWikilinks(markdown, options = {}) {
    const text = String(markdown || "").trim();
    if (!text) {
      return "";
    }
    const knownConceptTitles = Array.isArray(options.knownConceptTitles) ? options.knownConceptTitles : [];
    const articlePath = cleanPath(options.articlePath);
    const wikiFolder = cleanPath(this.settings.wikiFolder);
    const conceptsFolder = cleanPath(this.settings.conceptsFolder);
    const articlesFolder = cleanPath(this.settings.articlesFolder);
    const queriesFolder = cleanPath(this.settings.queriesFolder);

    return text.replace(/\[\[([^\]|#]+)(#[^\]|]+)?(?:\|([^\]]+))?\]\]/g, (match, rawTarget, rawHeading = "", rawAlias = "") => {
      const target = cleanPath(rawTarget);
      const heading = String(rawHeading || "");
      const alias = String(rawAlias || "").trim();
      if (!target) {
        return match;
      }

      const buildLink = (path, fallbackLabel = "") => {
        const cleanTarget = cleanPath(path);
        if (!cleanTarget) {
          return match;
        }
        const label = alias || fallbackLabel;
        const linkTarget = `${cleanTarget}${heading}`;
        return label ? `[[${linkTarget}|${label}]]` : `[[${linkTarget}]]`;
      };

      if (target.startsWith(`${wikiFolder}/`)) {
        return buildLink(target);
      }
      if (target.startsWith("概念/")) {
        return buildLink(joinPath(conceptsFolder, target.slice("概念/".length)));
      }
      if (target.startsWith("articles/")) {
        return buildLink(joinPath(articlesFolder, target.slice("articles/".length)));
      }
      if (target.startsWith("queries/")) {
        return buildLink(joinPath(queriesFolder, target.slice("queries/".length)));
      }

      const resolvedConcept = this.resolveConceptTitle(target, knownConceptTitles);
      if (resolvedConcept) {
        const fallbackLabel = alias ? "" : (target === resolvedConcept ? "" : target);
        return buildLink(joinPath(conceptsFolder, resolvedConcept), fallbackLabel);
      }

      if (articlePath) {
        const articleStem = stemname(articlePath);
        if (normalizeLookupKey(target) === normalizeLookupKey(articleStem)) {
          const fallbackLabel = alias ? "" : (target === articleStem ? "" : target);
          return buildLink(notePathFromFilePath(articlePath), fallbackLabel);
        }
      }

      return match;
    });
  }

  buildArticleNote({ file, articleTitle, articleSummary, sourceText, conceptTitles, sourceKind }) {
    const sourceSnapshot =
      sourceKind === "pdf"
        ? "PDF processed directly by Gemini. No local text snapshot was stored."
        : truncateText(sourceText, 50000);
    return [
      this.renderGeneratedFrontmatter({
        title: articleTitle,
        description: articleSummary,
        type: "article",
        source_path: file.path,
        source_kind: sourceKind,
        generated_by: GENERATED_BY,
        generated_at: nowIso(),
      }),
      "",
      `# ${articleTitle}`,
      "",
      "## Summary",
      "",
      articleSummary,
      "",
      "## Derived Concepts",
      "",
      conceptTitles.length
        ? conceptTitles.map((title) => `- ${makeWikiLink(joinPath(this.settings.conceptsFolder, title))}`).join("\n")
        : "- None",
      "",
      "## Source",
      "",
      `- Original file: \`${file.path}\``,
      "",
      "## Content Snapshot",
      "",
      sourceSnapshot,
      "",
    ].join("\n");
  }

  buildConceptNote({ concept, articlePath, sourcePath, knownConceptTitles }) {
    const related = Array.from(new Set((concept.related_concepts || []).map((item) => String(item || "").trim()).filter(Boolean).filter((item) => item !== concept.title)));
    const tags = Array.from(new Set((concept.tags || []).map((item) => String(item || "").trim()).filter(Boolean)));
    const normalizedBody = this.normalizeGeneratedWikilinks(concept.body, {
      knownConceptTitles,
      articlePath,
    });
    return [
      this.renderGeneratedFrontmatter({
        title: concept.title,
        description: concept.summary,
        type: "concept",
        tags,
        source_path: sourcePath,
        article_note: articlePath,
        generated_by: GENERATED_BY,
        generated_at: nowIso(),
      }),
      "",
      `# ${concept.title}`,
      "",
      "## Summary",
      "",
      concept.summary,
      "",
      "## Details",
      "",
      normalizedBody,
      "",
      "## Related Concepts",
      "",
      related.length ? related.map((item) => this.renderConceptReference(item, knownConceptTitles)).join("\n") : "- None",
      "",
      "## Sources",
      "",
      `- \`${sourcePath}\``,
      `- ${makeWikiLink(notePathFromFilePath(articlePath))}`,
      "",
    ].join("\n");
  }

  async rebuildGlobalIndex() {
    const conceptFiles = this
      .getAllFilesUnder(this.settings.conceptsFolder)
      .filter((file) => file.extension === "md")
      .sort((a, b) => a.path.localeCompare(b.path, "zh-Hant"));
    const articleFiles = this
      .getAllFilesUnder(this.settings.articlesFolder)
      .filter((file) => file.extension === "md")
      .sort((a, b) => a.path.localeCompare(b.path, "zh-Hant"));
    const queryFiles = this
      .getAllFilesUnder(this.settings.queriesFolder)
      .filter((file) => file.extension === "md" && basename(file.path) !== "_queue.md")
      .sort((a, b) => b.stat.mtime - a.stat.mtime)
      .slice(0, 20);

    const content = [
      this.renderGeneratedFrontmatter({
        title: "全域索引",
        description: "由 Second Brain Pipeline 自動維護的全域索引",
        type: "index",
        generated_by: GENERATED_BY,
        generated_at: nowIso(),
      }),
      "",
      "# 全域索引",
      "",
      "這是 LLM 知識庫系統的入口點。",
      "",
      "## 系統指南",
      "",
      "- [系統總覽](../system/LLM知識庫系統.md)",
      "- [Phase 1: 攝取](../system/Phases/Phase-1-Ingest.md)",
      "- [Phase 2: 編譯](../system/Phases/Phase-2-Compile.md)",
      "- [Phase 3: 查詢增強](../system/Phases/Phase-3-Query-Enhance.md)",
      "- [Phase 4: 檢查維護](../system/Phases/Phase-4-Lint.md)",
      "",
      "## 概念文章",
      "",
      conceptFiles.length
        ? conceptFiles.map((file) => `- ${makeWikiLink(notePathFromFilePath(file.path))}`).join("\n")
        : "- （尚無概念文章）",
      "",
      "## 衍生產出",
      "",
      `- articles/: ${articleFiles.length} 篇`,
      `- queries/: ${queryFiles.length} 篇`,
      "",
      "## 最近查詢",
      "",
      queryFiles.length
        ? queryFiles.map((file) => `- ${makeWikiLink(notePathFromFilePath(file.path))}`).join("\n")
        : "- （尚無查詢歸檔）",
      "",
      "## 最近更新",
      "",
      `- ${new Date().toISOString().slice(0, 10)}: 自動重建索引`,
      "",
    ].join("\n");

    await this.writeText(joinPath(this.settings.wikiFolder, "全域索引.md"), content);
  }

  async updatePendingFileIndex(rawFiles, stagingFiles) {
    const rawSection = rawFiles.length
      ? rawFiles.map((file) => `- \`${file.path}\``).join("\n")
      : "- （空）";
    const stagingSection = stagingFiles.length
      ? stagingFiles.map((file) => `- \`${file.path}\``).join("\n")
      : "- （空）";
    const content = [
      this.renderGeneratedFrontmatter({
        title: "待處理文件",
        description: "由 Second Brain Pipeline 自動產生的待處理清單",
        type: "index",
        generated_by: GENERATED_BY,
        generated_at: nowIso(),
      }),
      "",
      "# 待處理文件",
      "",
      "## raw/",
      "",
      rawSection,
      "",
      "## staging/",
      "",
      stagingSection,
      "",
      "## Notes",
      "",
      "- Phase 1 會保留 `raw/` 原件。",
      "- 若啟用自動暫存，僅會把可讀的文字檔複製到 `staging/`。",
      "- PDF 會保留在原位置，並在 Phase 2 直接交給 Gemini 處理。",
      "",
    ].join("\n");
    await this.writeText("system/index/待處理文件.md", content);
  }

  async getCompileCandidates() {
    const candidateMap = new Map();
    const addCandidate = (file, baseFolder, priority) => {
      if (!(file instanceof TFile) || !this.isSupportedCompileFile(file)) {
        return;
      }
      const key = this.relativeTo(baseFolder, file.path) || file.path;
      const current = candidateMap.get(key);
      if (!current || priority > current.priority) {
        candidateMap.set(key, { file, priority });
      }
    };

    for (const file of this.getAllFilesUnder(this.settings.rawFolder)) {
      addCandidate(file, this.settings.rawFolder, 1);
    }
    for (const file of this.getAllFilesUnder(this.settings.stagingFolder)) {
      addCandidate(file, this.settings.stagingFolder, 2);
    }
    return Array.from(candidateMap.values()).map((item) => item.file);
  }

  getMimeType(extension) {
    const ext = String(extension || "").toLowerCase();
    if (ext === "pdf") return "application/pdf";
    if (["mp3", "wav", "ogg"].includes(ext)) return `audio/${ext}`;
    if (ext === "m4a") return "audio/mp4";
    if (["mp4", "webm", "mov"].includes(ext)) return `video/${ext}`;
    if (["jpeg", "jpg", "png", "webp"].includes(ext)) return `image/${ext === "jpg" ? "jpeg" : ext}`;
    return "application/octet-stream";
  }

  async uploadFileToGemini(bytes, file) {
    const apiKey = this.getApiKey();
    if (!apiKey) throw new Error("No Gemini API key found.");
    
    const mimeType = this.getMimeType(file.extension);
    const contentSize = bytes.byteLength;
    
    const initUrl = `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`;
    const initResponse = await fetch(initUrl, {
      method: "POST",
      headers: {
        "X-Goog-Upload-Protocol": "resumable",
        "X-Goog-Upload-Command": "start",
        "X-Goog-Upload-Header-Content-Length": contentSize.toString(),
        "X-Goog-Upload-Header-Content-Type": mimeType,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ file: { display_name: file.name } })
    });

    if (!initResponse.ok) {
      throw new Error(`Failed to initialize upload: ${await initResponse.text()}`);
    }

    const uploadUrl = initResponse.headers.get("x-goog-upload-url") || initResponse.headers.get("X-Goog-Upload-URL");
    if (!uploadUrl) {
      throw new Error("Could not get upload URL from headers.");
    }

    const uploadResponse = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        "Content-Length": contentSize.toString(),
        "X-Goog-Upload-Offset": "0",
        "X-Goog-Upload-Command": "upload, finalize"
      },
      body: bytes
    });

    if (!uploadResponse.ok) {
      throw new Error(`Failed to upload file content: ${await uploadResponse.text()}`);
    }

    const responseData = await uploadResponse.json();
    return responseData.file;
  }

  async waitForMetadataProcessing(fileName) {
    const apiKey = this.getApiKey();
    const maxRetries = 30; // Maximum ~1.5 minutes
    const delayMs = 3000;

    for (let i = 0; i < maxRetries; i++) {
      const url = `https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${apiKey}`;
      const response = await fetch(url, { method: "GET" });
      
      if (!response.ok) {
        throw new Error(`Failed to check file state: ${await response.text()}`);
      }
      
      const fileData = await response.json();
      const state = fileData.state;

      if (state === "ACTIVE") {
        return fileData;
      } else if (state === "FAILED") {
        throw new Error(`Gemini background processing failed for file: ${fileName}`);
      }
      
      await sleep(delayMs);
    }
    throw new Error("Timeout: File analysis is taking too long to become ACTIVE.");
  }

  async deleteGeminiFile(fileName) {
    const apiKey = this.getApiKey();
    if (!apiKey) return;
    const url = `https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${apiKey}`;
    try {
      const response = await fetch(url, { method: "DELETE" });
      if (!response.ok) {
        console.warn(`[second-brain-pipeline] Failed to delete server file ${fileName}:`, await response.text());
      }
    } catch (e) {
      console.error(`[second-brain-pipeline] Error calling delete API for ${fileName}`, e);
    }
  }

  async buildCompileRequest(file, workflowContext, existingConceptTitles, preparedSource, uploadedFile = null) {
    const glossary = await this.readGlossary();
    const glossaryText = glossary ? `\nGLOSSARY MAPPINGS: ${JSON.stringify(glossary.mappings)}\n` : "";

    const systemInstruction = [
      "You are an LLM compiler for an Obsidian-based personal knowledge base.",
      "Follow the workflow documents as the governing rules.",
      glossaryText,
      "Write all human-readable output in Traditional Chinese used in Taiwan (zh-Hant).",
      "When creating [[links]], prioritize the exact terms from the provided GLOSSARY MAPPINGS if a concept matches.",
      "This rule applies even when the source document is in English or another language.",
      "Keep formal standard numbers, product names, and unavoidable technical terms in their original form when needed.",
      "Prefer concise, well-structured markdown.",
      "Generate concept notes that are useful for long-term wiki growth.",
      "Return JSON only.",
    ].join(" ");

    const intro = [
      "WORKFLOW DOCS",
      workflowContext,
      "",
      "EXISTING CONCEPT TITLES",
      existingConceptTitles.length ? existingConceptTitles.join(", ") : "(none)",
      "",
      "SOURCE FILE PATH",
      file.path,
      "",
      "5. related_concepts should prefer titles from the existing concept list when relevant.",
      "6. Identify any synonymous or near-synonymous terms with standard concepts and suggest them in `new_glossary_mappings`.",
      "7. CONSTRAINTS: Use the provided glossary for all [[wikilinks]] and #tags. If a glossary term has spaces, use hyphens '-' for tags (e.g., 'Breast Surgery' -> #Breast-Surgery).",
    ];

    if (glossary && glossary.mappings) {
      intro.push("", "GLOSSARY MAPPINGS (Preferred terminology)", JSON.stringify(glossary.mappings, null, 2));
    }

    const introText = intro.join("\n");

    if (preparedSource.sourceKind === "pdf" && uploadedFile) {
      return {
        systemInstruction,
        sourceKind: "pdf",
        sourceText: "",
        userParts: [
          { text: introText },
          {
            fileData: {
              mimeType: this.getMimeType(file.extension),
              fileUri: uploadedFile.uri,
            },
          },
          {
            text: "Treat the attached PDF as the primary source document for compilation.",
          },
        ],
      };
    } else if (preparedSource.sourceKind === "pdf") {
      throw new Error(`File API object missing for PDF file processing: ${file.path}`);
    }

    const sourceText = preparedSource.sourceText;
    return {
      systemInstruction,
      sourceKind: "text",
      sourceText,
      userParts: [
        {
          text: [
            introText,
            "",
            "SOURCE CONTENT",
            truncateText(sourceText, this.settings.maxContextChars),
          ].join("\n"),
        },
      ],
    };
  }

  async runPhase1(options = {}) {
    const silent = Boolean(options.silent);
    this.updateStatus("📡 Phase 1: Ingesting...");
    await this.ensureFolder(this.settings.rawFolder);
    await this.ensureFolder(this.settings.stagingFolder);
    await this.ensureFolder("system/index");

    const rawFiles = this.getAllFilesUnder(this.settings.rawFolder).filter((file) => file instanceof TFile);
    let stagedCount = 0;
    const directPdfCount = rawFiles.filter((file) => this.isPdfFile(file)).length;

    if (this.settings.autoStageTextFiles) {
      for (const file of rawFiles) {
        if (this.isPdfFile(file)) {
          continue;
        }
        if (!this.isTextFile(file)) {
          continue;
        }
        const relative = this.relativeTo(this.settings.rawFolder, file.path);
        const stagingPath = joinPath(this.settings.stagingFolder, relative);
        const source = await this.app.vault.cachedRead(file);
        await this.writeText(stagingPath, source);
        stagedCount += 1;
      }
    }

    const stagingFiles = this.getAllFilesUnder(this.settings.stagingFolder).filter((file) => file instanceof TFile);
    await this.updatePendingFileIndex(rawFiles, stagingFiles);

    if (!silent) {
      this.clearStatus();
      new Notice(
        `Phase 1 complete. raw: ${rawFiles.length}, staged text files: ${stagedCount}, pdf for direct compile: ${directPdfCount}`,
        7000
      );
    }
    return {
      rawCount: rawFiles.length,
      stagedCount,
      directPdfCount,
      stagingCount: stagingFiles.length,
    };
  }

  async collectExistingConceptTitles() {
    return this.getAllFilesUnder(this.settings.conceptsFolder)
      .filter((file) => file instanceof TFile && file.extension === "md")
      .map((file) => stemname(file.path));
  }

  async runPhase2(options = {}) {
    const silent = Boolean(options.silent);
    await this.ensureFolder(this.settings.articlesFolder);
    await this.ensureFolder(this.settings.conceptsFolder);
    await this.ensureFolder(this.settings.wikiFolder);

    let compileFiles = await this.getCompileCandidates();

    if (!compileFiles.length && this.settings.includeRawWhenStagingEmpty) {
      compileFiles = this.getAllFilesUnder(this.settings.rawFolder)
        .filter((file) => file instanceof TFile && this.isSupportedCompileFile(file));
    }

    if (!compileFiles.length) {
      if (!silent) {
        new Notice("Phase 2 skipped. No text or PDF files found in staging/ or raw/.", 7000);
      }
      return { compiledCount: 0, conceptCount: 0 };
    }

    const workflowContext = await this.getWorkflowContext();
    let existingConceptTitles = await this.collectExistingConceptTitles();
    let compiledCount = 0;
    let unchangedCount = 0;
    let conceptCount = 0;
    const skippedFiles = [];
    let cacheUpdated = false;

    const totalFiles = compileFiles.length;
    for (const [index, file] of compileFiles.entries()) {
      this.updateStatus("🧩 Phase 2: Compiling", `${index + 1}/${totalFiles}`);
      let uploadedFile = null;
      try {
        const sourcePath = cleanPath(file.path);
        const preparedSource = await this.prepareCompileSource(file);
        if (preparedSource.sourceKind === "text" && !preparedSource.sourceText.trim()) {
          unchangedCount += 1;
          continue;
        }

        if (await this.isCompileEntryUpToDate(sourcePath, preparedSource.fingerprint)) {
          unchangedCount += 1;
          continue;
        }

        const previousEntry = this.getCompileCacheEntry(sourcePath);

        if (preparedSource.sourceKind === "pdf") {
          uploadedFile = await this.uploadFileToGemini(preparedSource.bytes, file);
          await this.waitForMetadataProcessing(uploadedFile.name);
        }

        const compileRequest = await this.buildCompileRequest(
          file,
          workflowContext,
          existingConceptTitles,
          preparedSource,
          uploadedFile
        );

        const result = await this.requestStructuredJsonWithParts(
          compileRequest.systemInstruction,
          compileRequest.userParts,
          COMPILE_SCHEMA
        );

        // Merge new glossary mappings if any
        if (result.new_glossary_mappings) {
          await this.mergeGlossaryMappings(result.new_glossary_mappings);
        }
        const articleTitle = sanitizeFileName(result.article_title || stemname(file.path));
        const conceptTitles = (result.concept_notes || []).map((item) => sanitizeFileName(item.title)).filter(Boolean);
        const knownConceptTitles = Array.from(new Set([...existingConceptTitles, ...conceptTitles]));

        const articleNote = this.buildArticleNote({
          file,
          articleTitle,
          articleSummary: result.article_summary || "",
          sourceText: compileRequest.sourceText,
          conceptTitles,
          sourceKind: compileRequest.sourceKind,
        });

        const articleTarget = joinPath(this.settings.articlesFolder, `${articleTitle}.md`);
        const articleValidation = this.validateContent(articleNote);
        if (!articleValidation.valid) {
          throw new Error(`Generated article note failed validation: ${articleValidation.reason}`);
        }
        const articlePath = await this.writeGeneratedFile(articleTarget, articleNote);

        const generatedConceptPaths = [];
        for (const rawConcept of result.concept_notes || []) {
          const concept = Object.assign({}, rawConcept, {
            title: sanitizeFileName(rawConcept.title || "Untitled Concept"),
          });
          const conceptBody = this.buildConceptNote({
            concept,
            articlePath,
            sourcePath: file.path,
            knownConceptTitles,
          });
          const conceptPath = await this.resolveWritableGeneratedPath(joinPath(this.settings.conceptsFolder, `${concept.title}.md`));
          const validation = this.validateContent(conceptBody);
          if (!validation.valid) {
            console.warn(`[second-brain-pipeline] Validation failed for concept ${concept.title}: ${validation.reason}. Skipping write.`);
            new Notice(`Concept ${concept.title} validation failed: ${validation.reason}`);
            continue;
          }
          await this.writeText(conceptPath, conceptBody);
          generatedConceptPaths.push(conceptPath);
          conceptCount += 1;
        }

        this.setCompileCacheEntry(sourcePath, {
          fingerprint: preparedSource.fingerprint,
          compileProfile: COMPILE_PROFILE_VERSION,
          sourceKind: compileRequest.sourceKind,
          articlePath,
          conceptPaths: generatedConceptPaths,
          updatedAt: nowIso(),
        });
        await this.cleanupCompileOutputs(sourcePath, previousEntry, [articlePath, ...generatedConceptPaths]);
        cacheUpdated = true;

        existingConceptTitles = await this.collectExistingConceptTitles();
        compiledCount += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        skippedFiles.push(`${file.path}: ${message}`);
      } finally {
        if (uploadedFile && uploadedFile.name) {
          await this.deleteGeminiFile(uploadedFile.name);
          uploadedFile = null;
        }
      }
    }

    await this.rebuildGlobalIndex();
    if (cacheUpdated) {
      await this.saveData(this.settings);
    }

    if (!silent) {
      this.clearStatus();
      const parts = [
        `compiled ${compiledCount}`,
        `skipped unchanged ${unchangedCount}`,
        `concept notes ${conceptCount}`,
      ];
      if (skippedFiles.length) {
        parts.push(`errors ${skippedFiles.length}`);
      }
      new Notice(`Phase 2 complete. ${parts.join(", ")}.`, 8000);
      if (skippedFiles.length) {
        console.warn("[second-brain-pipeline] Skipped compile files:", skippedFiles);
      }
    }

    return { compiledCount, unchangedCount, conceptCount, skippedFiles };
  }

  async getGeminiEmbedding(text) {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error("No Gemini API key found for embedding.");
    }
    const embeddingModel = String(this.settings.geminiEmbeddingModel || "gemini-embedding-2-preview").trim();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(embeddingModel)}:embedContent?key=${apiKey}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: `models/${embeddingModel}`,
        content: { parts: [{ text }] }
      })
    });
    if (!response.ok) {
      throw new Error(`Embedding API error: ${await response.text()}`);
    }
    const data = await response.json();
    if (!data.embedding || !data.embedding.values) {
      throw new Error("Invalid embedding response");
    }
    return data.embedding.values;
  }

  cosineSimilarity(vecA, vecB) {
    if (!vecA || !vecB || vecA.length !== vecB.length || vecA.length === 0) return 0;
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  scoreFileForQuery(content, query) {
    const lowerContent = String(content || "").toLowerCase();
    const lowerQuery = String(query || "").toLowerCase().trim();
    if (!lowerQuery) {
      return 0;
    }
    let score = 0;
    if (lowerContent.includes(lowerQuery)) {
      score += 100;
    }
    const tokens = lowerQuery.split(/[\s,.;:!?/\\|()[\]{}]+/).filter((token) => token.length >= 2);
    for (const token of tokens) {
      const matches = lowerContent.split(token).length - 1;
      score += matches * 10;
    }
    return score;
  }

  async collectQueryContext(query) {
    const candidates = this.getAllFilesUnder(this.settings.wikiFolder)
      .filter((file) => file instanceof TFile && file.extension === "md")
      .filter((file) => !file.path.startsWith(`${cleanPath(this.settings.lintFolder)}/`))
      .filter((file) => basename(file.path) !== "_queue.md");

    if (!this.settings.embeddingsCache) {
      this.settings.embeddingsCache = {};
    }
    let cacheUpdated = false;

    let queryEmbedding = null;
    try {
      if (query && query.trim()) {
        new Notice("Second Brain Pipeline: 正在產生提問向量 (Hybrid Search)...", 4000);
        queryEmbedding = await this.getGeminiEmbedding(query.trim());
      }
    } catch (e) {
      console.warn("[second-brain-pipeline] Fetching query embedding failed:", e);
    }

    const scored = [];
    for (const file of candidates) {
      const content = await this.app.vault.cachedRead(file);
      
      const literalScore = this.scoreFileForQuery(content, query);
      
      let semanticScore = 0;
      let fileEmbedding = null;
      if (queryEmbedding && content.trim()) {
        const fingerprint = sha256(content);
        const cached = this.settings.embeddingsCache[file.path];
        if (cached && cached.fingerprint === fingerprint && cached.vector) {
          fileEmbedding = cached.vector;
        } else {
          try {
            const embedText = content.length > 8000 ? content.slice(0, 8000) : content;
            fileEmbedding = await this.getGeminiEmbedding(embedText);
            this.settings.embeddingsCache[file.path] = { fingerprint, vector: fileEmbedding };
            cacheUpdated = true;
          } catch (e) {
            console.warn(`[second-brain-pipeline] Failed to embed ${file.path}:`, e);
          }
        }
      }

      if (fileEmbedding && queryEmbedding) {
        semanticScore = this.cosineSimilarity(queryEmbedding, fileEmbedding);
      }

      const finalScore = literalScore + Math.max(0, semanticScore * 500);

      const folderPriority = file.path === joinPath(cleanPath(this.settings.wikiFolder), "全域索引.md")
        ? 0
        : file.path.startsWith("wiki/概念/")
          ? 1
          : file.path.startsWith("wiki/articles/")
            ? 2
            : 3;
            
      scored.push({ file, content, score: finalScore, folderPriority, literalScore, semanticScore });
    }

    if (cacheUpdated) {
      await this.saveData(this.settings);
    }

    scored.sort((a, b) => {
      if (Math.abs(b.score - a.score) > 0.01) {
        return b.score - a.score;
      }
      if (a.folderPriority !== b.folderPriority) {
        return a.folderPriority - b.folderPriority;
      }
      return b.file.stat.mtime - a.file.stat.mtime;
    });

    const selected = [];
    let total = 0;
    let limitCount = 0;
    
    for (const item of scored) {
      if (limitCount >= 10) break;
      const block = `FILE: ${item.file.path}\n${truncateText(item.content, 12000)}`;
      if (total && total + block.length > this.settings.maxContextChars) {
        continue;
      }
      selected.push(item.file.path);
      total += block.length;
      limitCount += 1;
      if (total >= this.settings.maxContextChars) {
        break;
      }
    }

    const contextBlocks = [];
    for (const path of selected) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) {
        const content = await this.app.vault.cachedRead(file);
        contextBlocks.push(`FILE: ${path}\n${truncateText(content, 12000)}`);
      }
    }
    return {
      selectedPaths: selected,
      context: contextBlocks.join("\n\n---\n\n"),
    };
  }

  async runPhase3(query, options = {}) {
    this.updateStatus("🔍 Phase 3: Querying...");
    const silent = Boolean(options.silent);
    await this.ensureFolder(this.settings.queriesFolder);

    const workflowContext = await this.getWorkflowContext();
    const queryContext = await this.collectQueryContext(query);
    const systemInstruction = [
      "You are the Phase 3 query agent for an Obsidian knowledge base.",
      "Answer strictly from the provided vault context when possible.",
      "If context is incomplete, say what is missing and infer carefully.",
      "Write the answer title and markdown in Traditional Chinese used in Taiwan (zh-Hant).",
      "Keep standard names and acronyms in their original form when needed.",
      "Return JSON only.",
    ].join(" ");
    const userPrompt = [
      "WORKFLOW DOCS",
      workflowContext,
      "",
      "QUESTION",
      query,
      "",
      "VAULT CONTEXT",
      queryContext.context || "(no vault context found)",
      "",
      "TASK",
      "Produce a title, a markdown answer, and the list of source paths you actually used.",
      "The markdown answer should be suitable to save directly as a note in wiki/queries/.",
      "Use Traditional Chinese for the title and answer unless a standard name should remain original.",
    ].join("\n");

    const result = await this.requestStructuredJson(systemInstruction, userPrompt, QUERY_SCHEMA);
    const title = sanitizeFileName(result.answer_title || query);
    const filePath = await this.writeGeneratedFile(
      joinPath(this.settings.queriesFolder, `${timestampSlug()} ${title}.md`),
      [
        this.renderGeneratedFrontmatter({
          title,
          description: query,
          type: "query",
          source_paths: result.source_paths || queryContext.selectedPaths,
          generated_by: GENERATED_BY,
          generated_at: nowIso(),
        }),
        "",
        `# ${title}`,
        "",
        "## Question",
        "",
        query,
        "",
        "## Answer",
        "",
        String(result.answer_markdown || "").trim(),
        "",
      ].join("\n")
    );

    await this.rebuildGlobalIndex();

    if (!silent) {
      this.clearStatus();
      new Notice(`Phase 3 complete. Saved answer to ${filePath}`, 8000);
    }
    return { query, filePath };
  }

  parseQueueItems(markdown) {
    const lines = String(markdown || "").split("\n");
    const items = [];
    lines.forEach((line, index) => {
      const match = line.match(/^- \[ \] (.+)$/);
      if (match) {
        items.push({
          lineIndex: index,
          question: match[1].trim(),
        });
      }
    });
    return { lines, items };
  }

  async runQueuedQueries(options = {}) {
    const silent = Boolean(options.silent);
    this.updateStatus("🔍 Phase 3: Queued Queries...");
    const queuePath = cleanPath(this.settings.queryQueuePath);
    const queueFile = this.app.vault.getAbstractFileByPath(queuePath);
    if (!(queueFile instanceof TFile)) {
      if (!silent) {
        new Notice("Queued query file not found. Skipping Phase 3 queue.", 5000);
      }
      return { processedCount: 0 };
    }

    const original = await this.app.vault.cachedRead(queueFile);
    const parsed = this.parseQueueItems(original);
    if (!parsed.items.length) {
      if (!silent) {
        new Notice("No unchecked queued queries found.", 5000);
      }
      return { processedCount: 0 };
    }

    let processedCount = 0;
    for (const item of parsed.items) {
      const answer = await this.runPhase3(item.question, { silent: true });
      parsed.lines[item.lineIndex] = `- [x] ${item.question} -> ${makeWikiLink(notePathFromFilePath(answer.filePath))}`;
      processedCount += 1;
    }

    await this.app.vault.modify(queueFile, parsed.lines.join("\n"));

    if (!silent) {
      this.clearStatus(`Processed ${processedCount} queued queries.`);
      new Notice(`Processed ${processedCount} queued queries.`, 7000);
    }
    return { processedCount };
  }

  buildLintScan(filesWithContent) {
    const noteNames = new Set(filesWithContent.map((item) => stemname(item.file.path)));
    const backlinks = new Map();
    const outgoingCounts = new Map();
    const brokenLinks = [];

    for (const item of filesWithContent) {
      const links = extractWikilinks(item.content);
      outgoingCounts.set(item.file.path, links.length);
      for (const link of links) {
        const stem = stemname(link);
        if (!noteNames.has(stem)) {
          brokenLinks.push({ path: item.file.path, target: link });
          continue;
        }
        const current = backlinks.get(stem) || 0;
        backlinks.set(stem, current + 1);
      }
    }

    const orphans = filesWithContent
      .filter((item) => item.file.path.startsWith("wiki/概念/"))
      .filter((item) => (backlinks.get(stemname(item.file.path)) || 0) === 0 && (outgoingCounts.get(item.file.path) || 0) === 0)
      .map((item) => item.file.path);

    const missingFrontmatter = filesWithContent
      .filter((item) => !item.content.trimStart().startsWith("---"))
      .map((item) => item.file.path);

    return {
      brokenLinks,
      orphans,
      missingFrontmatter,
    };
  }

  /**
   * Deterministically apply glossary mappings to all files.
   * Finds wikilinks to non-standard terms and replaces them with standard ones.
   */
  async deterministicApplyGlossaryMappings(allFilesWithContent, mappings) {
    const logs = [];
    if (!mappings || Object.keys(mappings).length === 0) return logs;

    const mappingKeys = Object.keys(mappings);

    for (const item of allFilesWithContent) {
      if (item.file.path.includes("/lint/")) continue;
      
      let content = item.content;
      let modified = false;
      for (const nonStandard of mappingKeys) {
        const standard = mappings[nonStandard];

        // Match [[nonStandard]], [[nonStandard|alias]], [[path/to/nonStandard]], etc.
        const escapedNonStandard = nonStandard.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(
          `\\[\\[(?:[^\\]]*\/)?${escapedNonStandard}(\\|[^\\]]*)?\\]\\]`,
          'gi'
        );
        const newContentLinks = content.replace(regex, (match, alias) => {
          // Keep the original alias if it exists, otherwise use standard name
          return alias ? `[[${standard}${alias}]]` : `[[${standard}]]`;
        });

        if (newContentLinks !== content) {
          content = newContentLinks;
          modified = true;
        }

        // --- Tag Replacement ---
        // Obsidian tags don't allow spaces. We check for hyphen and underscore variants.
        const tagStandard = standard.replace(/\s+/g, '-');
        const nonStandardHyphen = nonStandard.replace(/\s+/g, '-');
        const nonStandardUnderscore = nonStandard.replace(/\s+/g, '_');

        const tagVariants = Array.from(new Set([nonStandardHyphen, nonStandardUnderscore]));
        for (const variant of tagVariants) {
          const escapedVariant = variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          // Match #tag but not ##tag, and ensure it's not immediately followed by more tag characters
          const tagRegex = new RegExp(`(^|\\s)#${escapedVariant}(?![\\w\\/-])`, 'gi');
          
          const newContentTags = content.replace(tagRegex, `$1#${tagStandard}`);
          if (newContentTags !== content) {
            content = newContentTags;
            modified = true;
          }
        }
      }

      if (modified) {
        await this.app.vault.modify(item.file, content);
        item.content = content; // Update in-memory for next steps
        logs.push(`- 🏷️ **用語統一**: \`${item.file.path}\` (已對位至標準詞彙)`);
      }
    }
    return logs;
  }
  /**
   * Deterministic broken-link auto-fixer.
   * For each broken link it tries, in order:
   *   1. Exact case-insensitive stem match against existing notes.
   *   2. Fuzzy stem match (similarity >= 0.6).
   *   3. Create a minimal stub note in wiki/概念/ so the link resolves.
   * Modifies files in-place without backup. Returns log lines.
   */
  async deterministicFixBrokenLinks(brokenLinks, allFilesWithContent) {
    const logs = [];
    if (!brokenLinks || brokenLinks.length === 0) return logs;

    // Build lowercase-stem -> actual stemname map
    const stemMap = new Map();
    for (const item of allFilesWithContent) {
      const s = stemname(item.file.path);
      stemMap.set(s.toLowerCase(), s);
    }

    // Group by source file so we read/write each file only once
    const byFile = new Map();
    for (const bl of brokenLinks) {
      if (!byFile.has(bl.path)) byFile.set(bl.path, new Set());
      byFile.get(bl.path).add(bl.target);
    }

    for (const [filePath, targets] of byFile) {
      if (filePath.includes("/lint/")) continue; // skip lint folder

      const sourceFile = this.app.vault.getAbstractFileByPath(filePath);
      if (!(sourceFile instanceof TFile)) {
        logs.push(`- ⚠️ **找不到檔案**: \`${filePath}\``);
        continue;
      }

      let content = await this.app.vault.read(sourceFile);
      let modified = false;

      for (const target of targets) {
        const targetStem = stemname(target);
        const targetStemLower = targetStem.toLowerCase();

        // Strategy 1: case-insensitive exact match
        let resolvedStem = stemMap.get(targetStemLower) || null;

        // Strategy 2: fuzzy match
        if (!resolvedStem) {
          let bestSim = 0, bestStem = null;
          for (const [lower, real] of stemMap) {
            const sim = this.calculateSimilarity(targetStemLower, lower);
            if (sim > bestSim) { bestSim = sim; bestStem = real; }
          }
          if (bestSim >= 0.6) resolvedStem = bestStem;
        }

        // Strategy 3: create stub
        if (!resolvedStem) {
          const stubPath = joinPath(this.settings.conceptsFolder, `${targetStem}.md`);
          const stubContent = [
            "---",
            `title: "${targetStem}"`,
            `description: "自動建立的存根頁面"`,
            `type: "concept"`,
            `generated_by: "${GENERATED_BY}"`,
            `generated_at: "${nowIso()}"`,
            "---",
            "",
            `# ${targetStem}`,
            "",
            "> 此頁面由 Phase 4 Auto-Fix 自動建立，請補充相關內容。",
            "",
          ].join("\n");
          try {
            await this.app.vault.create(stubPath, stubContent);
            resolvedStem = targetStem;
            stemMap.set(targetStem.toLowerCase(), targetStem);
            logs.push(`- 🆕 **建立存根**: \`${stubPath}\``);
          } catch (e) {
            logs.push(`- ❌ **建立存根失敗**: \`${stubPath}\` (${e.message})`);
            continue;
          }
        }

        // Rewrite all occurrences in file content.
        // Matches [[Stem]], [[Stem|alias]], [[any/path/Stem]], [[any/path/Stem|alias]]
        const escapedStem = targetStem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(
          `\\[\\[(?:[^\\]]*\/)?${escapedStem}(\\|[^\\]]*)?\\]\\]`,
          'gi'
        );
        const newContent = content.replace(regex, (_, alias) =>
          alias ? `[[${resolvedStem}${alias}]]` : `[[${resolvedStem}]]`
        );
        if (newContent !== content) {
          content = newContent;
          modified = true;
        }
      }

      if (modified) {
        await this.app.vault.modify(sourceFile, content);
        logs.push(`- ✅ **連結修復**: \`${filePath}\``);
      }
    }
    return logs;
  }

  async runPhase4(options = {}) {
    const silent = Boolean(options.silent);
    this.updateStatus("⚖️ Phase 4: Maintenance...");
    await this.ensureFolder(this.settings.lintFolder);

    const lintFolderClean = cleanPath(this.settings.lintFolder);
    const files = this.getAllFilesUnder(this.settings.wikiFolder)
      .filter((file) => file instanceof TFile && file.extension === "md")
      .filter((file) => !file.path.startsWith(`${lintFolderClean}/`));
    const filesWithContent = [];
    for (const file of files) {
      filesWithContent.push({
        file,
        content: await this.app.vault.cachedRead(file),
      });
    }

    // --- Deterministic Auto-Fix FIRST (no AI, no backup) ---
    const autoFixLogs = [];
    if (this.settings.enableAutoFix) {
      this.updateStatus("⚖️ Phase 4: Maintenance", "正在自動修復...");
      new Notice("Phase 4: 正在執行自動連結修復與用語對位...", 4000);
      
      // 1. Apply Glossary Mappings first
      const glossary = await this.readGlossary();
      if (glossary && glossary.mappings) {
        const glossaryLogs = await this.deterministicApplyGlossaryMappings(filesWithContent, glossary.mappings);
        autoFixLogs.push(...glossaryLogs);
      }

      // 2. Fix Broken Links second
      const preScan = this.buildLintScan(filesWithContent);
      const fixLogs = await this.deterministicFixBrokenLinks(preScan.brokenLinks, filesWithContent);
      autoFixLogs.push(...fixLogs);
      // Re-read updated files
      for (const item of filesWithContent) {
        try { item.content = await this.app.vault.cachedRead(item.file); } catch (_) {}
      }
      // Include newly created stub files so post-fix scan sees them
      const newFiles = this.getAllFilesUnder(this.settings.wikiFolder)
        .filter((f) => f instanceof TFile && f.extension === "md")
        .filter((f) => !f.path.startsWith(`${lintFolderClean}/`))
        .filter((f) => !filesWithContent.some((e) => e.file.path === f.path));
      for (const f of newFiles) {
        try { filesWithContent.push({ file: f, content: await this.app.vault.cachedRead(f) }); } catch (_) {}
      }
    }

    // Build context for AI
    const knownConceptTitles = filesWithContent
      .filter((item) => item.file.path.startsWith(`${cleanPath(this.settings.conceptsFolder)}/`))
      .map((item) => stemname(item.file.path));
    const knownArticleTitles = filesWithContent
      .filter((item) => item.file.path.startsWith(`${cleanPath(this.settings.articlesFolder)}/`))
      .map((item) => stemname(item.file.path));

    // Build final scan (reflects state AFTER first-pass auto-fix)
    let scan = this.buildLintScan(filesWithContent);
    const workflowContext = await this.getWorkflowContext();
    const systemInstruction = [
      "You are the Phase 4 lint agent for an Obsidian knowledge base.",
      "Use the supplied scan results and workflow docs to generate a concise, actionable report.",
      "Write the report in Traditional Chinese used in Taiwan (zh-Hant).",
      "Return JSON only.",
    ].join(" ");
    const userPrompt = [
      "WORKFLOW DOCS",
      workflowContext,
      "",
      "AVAILABLE CONCEPTS",
      knownConceptTitles.join(", "),
      "",
      "AVAILABLE ARTICLES",
      knownArticleTitles.join(", "),
      "",
      "GLOSSARY MAPPINGS (Already Applied)",
      JSON.stringify((await this.readGlossary())?.mappings || {}, null, 2),
      "",
      "SCAN RESULTS (post first-pass auto-fix — these are remaining issues only)",
      JSON.stringify(scan, null, 2),
      "",
      "FILE SUMMARIES",
      filesWithContent
        .slice(0, 80)
        .map((item) => `FILE: ${item.file.path}\n${truncateText(item.content, 3000)}`)
        .join("\n\n---\n\n"),
      "",
      "TASK",
      "1. Summarize the wiki health, rank remaining issues by severity, and suggest new concept links worth adding.",
      "2. Identify any synonymous or near-synonymous terms used inconsistently and suggest them in `new_glossary_mappings`.",
      "3. Pay special attention to 'brokenLinks' in SCAN RESULTS. If a target is a long academic paper title or a non-standard name, identify the corresponding standard concept and suggest it in `new_glossary_mappings` (e.g., matching a long paper title to its core concept) so the system can autonomously fix it via these mappings.",
    ].join("\n");
    
    this.updateStatus("⚖️ Phase 4: Maintenance", "正在分析狀況並尋求優化方案...");
    const result = await this.requestStructuredJson(systemInstruction, userPrompt, LINT_SCHEMA);
    
    // Merge new glossary mappings if any
    if (result.new_glossary_mappings && result.new_glossary_mappings.length > 0) {
      await this.mergeGlossaryMappings(result.new_glossary_mappings);
      
      // --- Second-Pass Auto-Fix (Autonomous Fix based on AI suggestions) ---
      if (this.settings.enableAutoFix) {
        this.updateStatus("⚖️ Phase 4: Maintenance", "正在執行自主修復 (Second Pass)...");
        const glossary = await this.readGlossary();
        if (glossary && glossary.mappings) {
          const secondPassGlossaryLogs = await this.deterministicApplyGlossaryMappings(filesWithContent, glossary.mappings);
          autoFixLogs.push(...secondPassGlossaryLogs);
        }
        
        // Re-scan and fix links again with new glossary
        const interimScan = this.buildLintScan(filesWithContent);
        const secondPassFixLogs = await this.deterministicFixBrokenLinks(interimScan.brokenLinks, filesWithContent);
        autoFixLogs.push(...secondPassFixLogs);

        // Re-read updated files again for final scan
        for (const item of filesWithContent) {
           try { item.content = await this.app.vault.cachedRead(item.file); } catch (_) {}
        }
      }
    }

    // Final Scan for Report (reflects state AFTER second-pass)
    scan = this.buildLintScan(filesWithContent);

    const autoFixSection = this.settings.enableAutoFix
      ? (autoFixLogs.length > 0 ? autoFixLogs.join("\n") : "- 沒有發現需要自動修復的項目。")
      : "- Auto-Fix 功能目前為關閉狀態。";

    const reportPath = await this.writeGeneratedFile(
      joinPath(this.settings.lintFolder, `report-${timestampSlug()}.md`),
      [
        this.renderGeneratedFrontmatter({
          title: "Lint Report",
          description: "自動產生的知識庫 lint 報告",
          type: "lint-report",
          generated_by: GENERATED_BY,
          generated_at: nowIso(),
        }),
        "",
        "# Lint Report",
        "",
        "## 🔧 Auto-Fix 自動修復紀錄",
        "",
        autoFixSection,
        "",
        "## Overview",
        "",
        String(result.overview || "").trim(),
        "",
        "## Issues",
        "",
        (result.issues || []).length
          ? result.issues
              .map((issue) =>
                [
                  `### [${String(issue.severity || "").toUpperCase()}] ${issue.title}`,
                  "",
                  `- File: \`${issue.file_path}\``,
                  `- Details: ${issue.details}`,
                  `- Suggestion: ${issue.suggestion}`,
                  "",
                ].join("\n")
              )
              .join("\n")
          : "No issues reported.",
        "",
        "## New Connections",
        "",
        (result.new_connections || []).length
          ? result.new_connections
              .map(
                (connection) =>
                  `- ${this.formatConceptReference(connection.from, knownConceptTitles)} -> ${this.formatConceptReference(
                    connection.to,
                    knownConceptTitles
                  )}: ${connection.rationale}`
              )
              .join("\n")
          : "No new connection suggestions.",
        "",
        "## Deterministic Scan Snapshot (post-fix)",
        "",
        "```json",
        JSON.stringify(scan, null, 2),
        "```",
        "",
      ].join("\n")
    );

    if (!silent) {
      this.clearStatus();
      new Notice(`Phase 4 complete. Saved lint report to ${reportPath}`, 8000);
    }
    return {
      reportPath,
      issueCount: (result.issues || []).length,
    };
  }

  async runFullPipeline() {
    this.updateStatus("🚀 Pipeline: Starting...");
    new Notice("Running Second Brain full pipeline...", 4000);
    const phase1 = await this.runPhase1({ silent: true });
    const phase2 = await this.runPhase2({ silent: true });
    const queued = await this.runQueuedQueries({ silent: true });
    const phase4 = await this.runPhase4({ silent: true });

    this.clearStatus("✅ Pipeline Complete");
    new Notice(
      `Pipeline complete. raw=${phase1.rawCount}, staged=${phase1.stagedCount}, compiled=${phase2.compiledCount}, unchanged=${phase2.unchangedCount || 0}, queuedQueries=${queued.processedCount}, lintIssues=${phase4.issueCount}`,
      12000
    );

    // Auto-fix broken links after pipeline if there are issues
    if (phase4.issueCount > 0) {
      new Notice("Broken links detected. Running auto-fix...", 5000);
      await this.runLinkAutoFix({ silent: true });
    }
  }

  async runLinkAutoFix(options = {}) {
    this.updateStatus("🔧 Auto-Fixing Links...");
    const silent = Boolean(options.silent);
    const wikiFiles = this.getAllFilesUnder(this.settings.wikiFolder)
      .filter((file) => file instanceof TFile && file.extension === "md");
    
    const filesWithContent = [];
    for (const file of wikiFiles) {
      filesWithContent.push({
        file,
        content: await this.app.vault.cachedRead(file),
      });
    }

    const scan = this.buildLintScan(filesWithContent);
    const brokenLinks = scan.brokenLinks || [];
    if (!brokenLinks.length) {
      if (!silent) new Notice("No broken links to fix.");
      return;
    }

    const allNoteTitles = filesWithContent.map(i => stemname(i.file.path));
    let fixCount = 0;

    for (const link of brokenLinks) {
      const targetName = basename(link.target).replace(".md", "");
      let bestMatch = null;
      let highestSimilarity = 0;

      for (const title of allNoteTitles) {
        const sim = this.calculateSimilarity(targetName, title);
        if (sim > highestSimilarity) {
          highestSimilarity = sim;
          bestMatch = title;
        }
      }

      if (bestMatch && highestSimilarity > 0.8) {
        const file = this.app.vault.getAbstractFileByPath(link.path);
        if (file instanceof TFile) {
          const content = await this.app.vault.cachedRead(file);
          const regex = new RegExp(`\\[\\[${link.target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\|[^\\]]+)?\\]\\]`, 'g');
          const newContent = content.replace(regex, (match, alias) => {
            const matchedFile = wikiFiles.find(f => stemname(f.path) === bestMatch);
            if (matchedFile) {
              const newPath = notePathFromFilePath(matchedFile.path);
              return alias ? `[[${newPath}${alias}]]` : `[[${newPath}]]`;
            }
            return match;
          });

          if (newContent !== content) {
            await this.app.vault.modify(file, newContent);
            fixCount += 1;
          }
        }
      }
    }

    if (!silent || fixCount > 0) {
      this.clearStatus(`Repaired ${fixCount} links`);
      new Notice(`Auto-fix complete. Repaired ${fixCount} links.`, 8000);
    }
  }
}

class SecondBrainPipelineSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Second Brain Pipeline" });

    new Setting(containerEl)
      .setName("Gemini API key")
      .setDesc("注意：輸入在此處會儲存於 data.json。若要更高安全性，請將 Key 放在 Vault 根目錄的 .env 檔案中 (GEMINI_API_KEY=...) 並確保 .env 已加入 .gitignore。")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("AIza...")
          .setValue(this.plugin.settings.geminiApiKey)
          .onChange(async (value) => {
            this.plugin.settings.geminiApiKey = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Gemini model")
      .setDesc("REST model name used for pipeline runs.")
      .addText((text) =>
        text
          .setPlaceholder("gemini-2.5-flash")
          .setValue(this.plugin.settings.geminiModel)
          .onChange(async (value) => {
            this.plugin.settings.geminiModel = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Gemini embedding model")
      .setDesc("REST model name used for Phase 3 vector generation.")
      .addText((text) =>
        text
          .setPlaceholder("gemini-embedding-2-preview")
          .setValue(this.plugin.settings.geminiEmbeddingModel)
          .onChange(async (value) => {
            this.plugin.settings.geminiEmbeddingModel = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Temperature")
      .setDesc("Lower is more deterministic.")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.temperature)).onChange(async (value) => {
          const parsed = Number(value);
          if (!Number.isNaN(parsed)) {
            this.plugin.settings.temperature = parsed;
            await this.plugin.saveSettings();
          }
        })
      );

    new Setting(containerEl)
      .setName("Max context chars")
      .setDesc("Approximate upper bound for context sent to Gemini.")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.maxContextChars)).onChange(async (value) => {
          const parsed = Number(value);
          if (!Number.isNaN(parsed) && parsed > 1000) {
            this.plugin.settings.maxContextChars = parsed;
            await this.plugin.saveSettings();
          }
        })
      );

    new Setting(containerEl)
      .setName("Max output tokens")
      .setDesc("Maximum tokens requested from Gemini per call.")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.maxOutputTokens)).onChange(async (value) => {
          const parsed = Number(value);
          if (!Number.isNaN(parsed) && parsed > 256) {
            this.plugin.settings.maxOutputTokens = parsed;
            await this.plugin.saveSettings();
          }
        })
      );

    new Setting(containerEl)
      .setName("Retry count")
      .setDesc("How many times to retry when Gemini returns 429/5xx busy errors.")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.retryCount)).onChange(async (value) => {
          const parsed = Number(value);
          if (!Number.isNaN(parsed) && parsed >= 0) {
            this.plugin.settings.retryCount = parsed;
            await this.plugin.saveSettings();
          }
        })
      );

    new Setting(containerEl)
      .setName("Retry base delay ms")
      .setDesc("Base backoff delay before retrying busy Gemini requests.")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.retryBaseDelayMs)).onChange(async (value) => {
          const parsed = Number(value);
          if (!Number.isNaN(parsed) && parsed >= 250) {
            this.plugin.settings.retryBaseDelayMs = parsed;
            await this.plugin.saveSettings();
          }
        })
      );

    new Setting(containerEl)
      .setName("Max inline PDF bytes")
      .setDesc("PDFs at or below this size are sent directly to Gemini as application/pdf.")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.pdfInlineMaxBytes)).onChange(async (value) => {
          const parsed = Number(value);
          if (!Number.isNaN(parsed) && parsed >= 1024 * 100) {
            this.plugin.settings.pdfInlineMaxBytes = parsed;
            await this.plugin.saveSettings();
          }
        })
      );

    containerEl.createEl("h3", { text: "Paths" });

    const pathFields = [
      ["rawFolder", "Raw folder"],
      ["stagingFolder", "Staging folder"],
      ["wikiFolder", "Wiki root"],
      ["conceptsFolder", "Concept notes folder"],
      ["articlesFolder", "Article archive folder"],
      ["queriesFolder", "Query archive folder"],
      ["lintFolder", "Lint folder"],
      ["queryQueuePath", "Queued query note path"],
    ];

    for (const [key, label] of pathFields) {
      new Setting(containerEl)
        .setName(label)
        .addText((text) =>
          text.setValue(String(this.plugin.settings[key] || "")).onChange(async (value) => {
            this.plugin.settings[key] = cleanPath(value);
            await this.plugin.saveSettings();
          })
        );
    }

    new Setting(containerEl)
      .setName("Auto-stage text files")
      .setDesc("Copy readable text files from raw/ to staging/ during Phase 1.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoStageTextFiles).onChange(async (value) => {
          this.plugin.settings.autoStageTextFiles = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Fallback to raw/ when staging/ is empty")
      .setDesc("Lets Phase 2 compile from raw/ if staging/ has no text files.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.includeRawWhenStagingEmpty).onChange(async (value) => {
          this.plugin.settings.includeRawWhenStagingEmpty = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Enable Auto-Fix (Phase 4)")
      .setDesc("啟用後，Phase 4 會自動修復斷裂連結(包括大小寫不一致、路徑前綴错誤)，並對找不到對應頁面的連結自動建立存根頁面。修復結果將記錄於 Lint Report 中。")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enableAutoFix || false).onChange(async (value) => {
          this.plugin.settings.enableAutoFix = value;
          await this.plugin.saveSettings();
        })
      );
  }
}

module.exports = SecondBrainPipelinePlugin;
