// @bun
// src/tui.ts
import { createElement, insert, setProp } from "@opentui/solid";
import { watch } from "fs";
import { createSignal } from "solid-js";

// src/config.ts
import { homedir } from "os";
var HOME = homedir() ?? "";
var CONFIG_PATH = `${HOME}/.config/opencode/usage-monitor.json`;
var OMO_CONFIG_PATH = `${HOME}/.config/opencode/oh-my-openagent.json`;
var CONFIG_DEFAULTS = {
  enabled: true,
  default_collapsed: false,
  refresh_ms: 60000,
  request_timeout_ms: 15000,
  show_openai: true,
  show_zai: true,
  show_details: false,
  default_provider_collapsed: true,
  debug: false,
  width: 34,
  symbols: "unicode",
  max_detail_lines: 4,
  max_windows: 3,
  max_model_lines: 1,
  refresh_keybind: "<leader>q"
};
function mergeUsageConfig(partial) {
  return { ...CONFIG_DEFAULTS, ...partial };
}
async function readJsonFile(path) {
  const file = Bun.file(path);
  if (!await file.exists())
    return null;
  try {
    return JSON.parse(await file.text());
  } catch (_error) {
    return null;
  }
}
async function readUsageConfig() {
  const dedicated = await readJsonFile(CONFIG_PATH);
  if (dedicated)
    return mergeUsageConfig(parseUsageConfig(dedicated));
  const omo = await readJsonFile(OMO_CONFIG_PATH);
  if (omo && typeof omo.usage_monitor === "object" && omo.usage_monitor !== null) {
    return mergeUsageConfig(parseUsageConfig(omo.usage_monitor));
  }
  return { ...CONFIG_DEFAULTS };
}
function parseUsageConfig(raw) {
  const { enabled, default_collapsed, refresh_ms, request_timeout_ms, show_openai, show_zai } = raw;
  const { show_details, default_provider_collapsed, debug, width, symbols, max_detail_lines, max_windows, max_model_lines, refresh_keybind } = raw;
  return {
    ...typeof enabled === "boolean" ? { enabled } : {},
    ...typeof default_collapsed === "boolean" ? { default_collapsed } : {},
    ...typeof refresh_ms === "number" ? { refresh_ms } : {},
    ...typeof request_timeout_ms === "number" ? { request_timeout_ms } : {},
    ...typeof show_openai === "boolean" ? { show_openai } : {},
    ...typeof show_zai === "boolean" ? { show_zai } : {},
    ...typeof show_details === "boolean" ? { show_details } : {},
    ...typeof default_provider_collapsed === "boolean" ? { default_provider_collapsed } : {},
    ...typeof debug === "boolean" ? { debug } : {},
    ...typeof width === "number" ? { width } : {},
    ...symbols === "unicode" || symbols === "ascii" ? { symbols } : {},
    ...typeof max_detail_lines === "number" ? { max_detail_lines } : {},
    ...typeof max_windows === "number" ? { max_windows } : {},
    ...typeof max_model_lines === "number" ? { max_model_lines } : {},
    ...typeof refresh_keybind === "string" && refresh_keybind.length > 0 ? { refresh_keybind } : {}
  };
}
function configFingerprint(config) {
  return JSON.stringify(Object.entries(config).sort(([left], [right]) => left.localeCompare(right)));
}

// src/cache.ts
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { homedir as homedir2 } from "os";
import { join } from "path";
var CACHE_FILE_NAME = "usage-monitor.json";
var CACHE_DIR = join(process.env.HOME ?? homedir2(), ".cache", "opencode");
function getCachePath() {
  return join(CACHE_DIR, CACHE_FILE_NAME);
}
function readCache() {
  try {
    const cachePath = getCachePath();
    const content = readFileSync(cachePath, "utf8");
    const parsed = JSON.parse(content);
    if (!isCachePayload(parsed))
      return null;
    return parsed.providers;
  } catch {
    return null;
  }
}
function writeCache(providers) {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    const cachePath = getCachePath();
    const tmpPath = `${cachePath}.tmp`;
    const payload = { version: 1, providers };
    writeFileSync(tmpPath, JSON.stringify(payload, null, 0));
    renameSync(tmpPath, cachePath);
  } catch {
    return;
  }
}
function isProviderFresh(provider, ttlMs) {
  return provider.fetchedAt !== undefined && Date.now() - provider.fetchedAt < ttlMs;
}
function filterFreshProviders(cached, ttlMs) {
  return Object.fromEntries(Object.entries(cached).filter(([, provider]) => isProviderFresh(provider, ttlMs)));
}
function staleProviderIds(cached, activeIds, ttlMs) {
  if (cached === null)
    return activeIds;
  return activeIds.filter((id) => {
    const provider = cached[id];
    return provider === undefined || !isProviderFresh(provider, ttlMs);
  });
}
function isCachePayload(value) {
  if (!isRecord(value))
    return false;
  return value.version === 1 && isProviderRecord(value.providers);
}
function isProviderRecord(value) {
  if (!isRecord(value))
    return false;
  return Object.values(value).every(isStandardUsageProvider);
}
function isStandardUsageProvider(value) {
  if (!isRecord(value))
    return false;
  return typeof value.id === "string" && typeof value.displayName === "string" && isProviderStatus(value.status) && Array.isArray(value.windows);
}
function isProviderStatus(value) {
  return value === "loading" || value === "ready" || value === "partial" || value === "missing-auth" || value === "forbidden" || value === "unsupported" || value === "error";
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/auth.ts
import { homedir as homedir3 } from "os";
var HOME2 = homedir3() ?? "";
var AUTH_PATH = `${HOME2}/.local/share/opencode/auth.json`;
function shortError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.split(`
`)[0] ?? "Invalid JSON";
}
function extractToken(entry) {
  if (!entry)
    return;
  return entry.key || entry.apiKey || entry.api_key || entry.token || entry.accessToken || entry.auth_token || entry.access || entry.refresh || undefined;
}
async function readAuthFile() {
  const file = Bun.file(AUTH_PATH);
  if (!await file.exists())
    return { kind: "missing", path: AUTH_PATH };
  try {
    const parsed = JSON.parse(await file.text());
    return { kind: "loaded", path: AUTH_PATH, auth: parsed };
  } catch (error) {
    return { kind: "invalid", path: AUTH_PATH, error: shortError(error) };
  }
}
function discoverOpenAICredential(auth, env = process.env) {
  const openai = asAuthEntry(auth.openai);
  const accessToken = openai?.access;
  if (typeof accessToken === "string" && accessToken.length > 0) {
    return { token: accessToken };
  }
  const apiKey = env.OPENAI_API_KEY;
  if (apiKey)
    return { token: apiKey };
  return { message: "auth missing" };
}
function discoverZaiCredential(auth, env = process.env) {
  const zaiCodingPlan = extractToken(asAuthEntry(auth["zai-coding-plan"]));
  if (zaiCodingPlan)
    return { token: zaiCodingPlan, baseUrl: "https://api.z.ai" };
  const zai = extractToken(asAuthEntry(auth.zai));
  if (zai)
    return { token: zai, baseUrl: "https://api.z.ai" };
  const zhipu = extractToken(asAuthEntry(auth.zhipu));
  if (zhipu)
    return { token: zhipu, baseUrl: "https://open.bigmodel.cn" };
  const zaiEnv = env.ZAI_API_KEY;
  if (zaiEnv)
    return { token: zaiEnv, baseUrl: "https://api.z.ai" };
  const zaiCodingPlanEnv = env.ZAI_CODING_PLAN_API_KEY;
  if (zaiCodingPlanEnv)
    return { token: zaiCodingPlanEnv, baseUrl: "https://api.z.ai" };
  const zhipuEnv = env.ZHIPU_API_KEY;
  if (zhipuEnv)
    return { token: zhipuEnv, baseUrl: "https://open.bigmodel.cn" };
  const zhipuaiEnv = env.ZHIPUAI_API_KEY;
  if (zhipuaiEnv)
    return { token: zhipuaiEnv, baseUrl: "https://open.bigmodel.cn" };
  return { message: "auth missing" };
}
function asAuthEntry(value) {
  return value && typeof value === "object" ? value : undefined;
}

// src/sanitize.ts
var SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9_-]{20,}/g,
  /sk-proj-[a-zA-Z0-9_-]{20,}/g,
  /Bearer\s+[a-zA-Z0-9._-]{10,}/g,
  /key[=:]\s*[a-zA-Z0-9._-]{10,}/gi,
  /token[=:]\s*[a-zA-Z0-9._-]{10,}/gi,
  /api[_-]?key[=:]\s*[a-zA-Z0-9._-]{10,}/gi,
  /Authorization:\s*(?:Bearer\s+)?\S+/gi
];
function looksSecretKey(key) {
  const lower = key.toLowerCase();
  return /authorization|secret|password|credential|api[_-]?key|auth[_-]?token|access[_-]?token/.test(lower) || /(^|[_-])(key|token)($|[_-])/.test(lower);
}
function sanitizeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  let sanitized = message;
  for (const pattern of SECRET_PATTERNS) {
    sanitized = sanitized.replace(pattern, "[redacted]");
  }
  return sanitized.split(`
`)[0] ?? "error";
}
function sanitizeAdditionalProperties(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([key, value]) => {
    if (looksSecretKey(key))
      return false;
    if (typeof value === "string" && hasSecretPattern(value))
      return false;
    return true;
  }));
}
function hasSecretPattern(value) {
  return SECRET_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(value);
  });
}

// src/severity.ts
function isLimitReached(window) {
  return window.limitReached === true || (window.percentage ?? 0) >= 100 || window.remaining === 0;
}
function getWindowSeverity(window) {
  if (isLimitReached(window))
    return "critical";
  if ((window.percentage ?? 0) >= 75)
    return "warning";
  return "normal";
}

// src/providers/shared.ts
function asRecord(value) {
  return value && typeof value === "object" ? value : null;
}
function readString(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function readNumber(value, fallback) {
  if (typeof value === "number" && Number.isFinite(value))
    return value;
  return fallback;
}
function slug(name) {
  return name?.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "limit";
}
function normalizeEpochMs(value) {
  const epochMs = readNumber(value);
  if (epochMs === undefined || epochMs <= 0)
    return;
  return epochMs < 10000000000 ? epochMs * 1000 : epochMs;
}
function createTimeoutController(timeoutMs, parent) {
  const controller = new AbortController;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  parent?.addEventListener("abort", abort, { once: true });
  const clear = () => {
    clearTimeout(timeoutId);
    parent?.removeEventListener("abort", abort);
  };
  controller.clear = clear;
  controller.dispose = clear;
  return controller;
}
function createStatusProvider(id, displayName) {
  return (status, message) => ({
    id,
    displayName,
    status,
    statusText: sanitizeError(message),
    errorMessage: status === "error" ? sanitizeError(message) : undefined,
    windows: []
  });
}

// src/providers/openai.ts
var OPENAI_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
var statusProvider = createStatusProvider("openai", "openai");
var openAIUsageAdapter = {
  id: "openai",
  displayName: "openai",
  isAvailable: () => true,
  fetchUsage: fetchOpenAIUsage
};
async function fetchOpenAIUsage(ctx, signal) {
  const credential = discoverOpenAICredential(ctx.auth, ctx.env);
  if (!("token" in credential))
    return statusProvider("missing-auth", credential.message);
  const controller = createTimeoutController(ctx.timeoutMs, signal);
  try {
    const response = await fetch(OPENAI_USAGE_URL, {
      headers: { Authorization: `Bearer ${credential.token}`, Accept: "application/json" },
      signal: controller.signal
    });
    if (response.status === 401 || response.status === 403)
      return statusProvider("forbidden", "forbidden");
    if (!response.ok)
      return statusProvider("error", `api ${response.status}`);
    return normalizeWhamUsage(await response.json());
  } catch (error) {
    return statusProvider("error", controller.signal.aborted ? "timeout" : sanitizeError(error));
  } finally {
    controller.dispose();
  }
}
function normalizeWhamUsage(raw, nowMs = Date.now()) {
  const parsed = parseWhamUsage(raw);
  const windows = [
    parsed.primary ? rateWindowToStandard("openai-primary", "rolling", parsed.primary, parsed.limitReached ?? false, nowMs) : undefined,
    parsed.secondary ? rateWindowToStandard("openai-secondary", "weekly", parsed.secondary, false, nowMs) : undefined
  ].filter((window) => window !== undefined);
  const alerts = parsed.additionalLimits.filter((limit) => limit.limitReached).map((limit) => ({ id: `${slug(limit.label)}-limit`, label: `${limit.label} LIMIT`, severity: "critical" }));
  const status = windows.length > 0 ? "ready" : "partial";
  return {
    id: "openai",
    displayName: "openai",
    status,
    ...status === "partial" ? { statusText: "partial data" } : {},
    ...parsed.plan ? { plan: parsed.plan } : {},
    windows,
    ...alerts.length > 0 ? { alerts } : {},
    additionalProperties: sanitizeAdditionalProperties(parsed.properties),
    fetchedAt: nowMs
  };
}
function parseWhamUsage(raw) {
  const data = asRecord(raw) ?? {};
  const rateLimit = asRecord(data.rate_limit) ?? {};
  return {
    plan: readString(data.plan_type),
    primary: parseRateWindow(rateLimit.primary_window),
    secondary: parseRateWindow(rateLimit.secondary_window),
    limitReached: rateLimit.limit_reached === true,
    additionalLimits: parseAdditionalLimits(data.additional_rate_limits),
    properties: collectWhamProperties(data)
  };
}
function parseRateWindow(raw) {
  const data = asRecord(raw);
  if (!data)
    return;
  return {
    usedPercent: readNumber(data.used_percent),
    limitWindowSeconds: readNumber(data.limit_window_seconds),
    resetAfterSeconds: readNumber(data.reset_after_seconds),
    resetAt: readNumber(data.reset_at)
  };
}
function rateWindowToStandard(id, kind, window, limitReached, nowMs) {
  const percentage = window.usedPercent;
  const resetAt = normalizeEpochMs(window.resetAt) ?? resetAfterToEpochMs(window.resetAfterSeconds, nowMs);
  if (percentage === undefined && resetAt === undefined && window.limitWindowSeconds === undefined)
    return;
  const standard = {
    id,
    label: kind === "weekly" ? "week" : secondsToLabel(window.limitWindowSeconds),
    kind,
    ...percentage !== undefined ? { percentage } : {},
    ...resetAt !== undefined ? { resetAt } : {},
    ...limitReached ? { limitReached: true } : {}
  };
  return { ...standard, severity: getWindowSeverity(standard) };
}
function collectWhamProperties(data) {
  const credits = asRecord(data.credits);
  const spendControl = asRecord(data.spend_control);
  const resetCredits = asRecord(data.rate_limit_reset_credits);
  return {
    ...flattenObject("credits", credits),
    ...flattenObject("spendControl", spendControl),
    ...flattenObject("rateLimitResetCredits", resetCredits)
  };
}
function parseAdditionalLimits(raw) {
  if (!Array.isArray(raw))
    return [];
  return raw.flatMap((entry) => {
    const data = asRecord(entry);
    if (!data)
      return [];
    const rateLimit = asRecord(data.rate_limit);
    const label = readString(data.metered_feature) ?? readString(data.limit_name) ?? "limit";
    return [{ label, limitReached: rateLimit?.limit_reached === true }];
  });
}
function flattenObject(prefix, value) {
  if (!value)
    return {};
  return Object.fromEntries(Object.entries(value).map(([key, val]) => [`${prefix}${capitalize(key)}`, val]));
}
function secondsToLabel(seconds) {
  if (seconds === undefined || seconds <= 0)
    return "rolling";
  if (seconds % 3600 === 0)
    return `${seconds / 3600}h`;
  if (seconds % 60 === 0)
    return `${seconds / 60}m`;
  return `${seconds}s`;
}
function resetAfterToEpochMs(seconds, nowMs) {
  return seconds === undefined ? undefined : nowMs + seconds * 1000;
}
function capitalize(value) {
  return value.length === 0 ? value : `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}

// src/providers/zai.ts
var QUOTA_PATH = "/api/monitor/usage/quota/limit";
var statusProvider2 = createStatusProvider("zai", "z.ai");
var zaiUsageAdapter = {
  id: "zai",
  displayName: "z.ai",
  isAvailable: () => true,
  fetchUsage: fetchZaiUsage
};
async function fetchZaiUsage(ctx, signal) {
  const credential = discoverZaiCredential(ctx.auth, ctx.env);
  if (!("token" in credential))
    return statusProvider2("missing-auth", credential.message);
  const controller = createTimeoutController(ctx.timeoutMs, signal);
  try {
    const response = await fetch(`${credential.baseUrl}${QUOTA_PATH}`, {
      headers: { Authorization: credential.token, Accept: "application/json" },
      signal: controller.signal
    });
    if (response.status === 401 || response.status === 403)
      return statusProvider2("forbidden", "forbidden");
    if (!response.ok)
      return statusProvider2("error", `api ${response.status}`);
    return normalizeZaiQuota(await response.json(), credential.baseUrl);
  } catch (error) {
    return statusProvider2("error", controller.signal.aborted ? "timeout" : sanitizeError(error));
  } finally {
    controller.dispose();
  }
}
function normalizeZaiQuota(raw, baseUrl = "https://api.z.ai", nowMs = Date.now()) {
  const payload = extractPayload(raw);
  const limits = parseLimits(payload.limits);
  const windows = limits.map((limit) => limitToWindow(limit, nowMs));
  const modelBreakdown = limits.flatMap((limit) => limit.usageDetails ?? []);
  return {
    id: "zai",
    displayName: "z.ai",
    status: windows.length > 0 ? "ready" : "partial",
    ...windows.length === 0 ? { statusText: "partial data" } : {},
    ...typeof payload.level === "string" ? { plan: payload.level } : {},
    windows,
    ...modelBreakdown.length > 0 ? { modelBreakdown } : {},
    additionalProperties: sanitizeAdditionalProperties({ providerBaseUrl: baseUrl }),
    fetchedAt: nowMs
  };
}
function extractPayload(raw) {
  const root = asRecord(raw) ?? {};
  return asRecord(root.data) ?? root;
}
function parseLimits(raw) {
  if (!Array.isArray(raw))
    return [];
  return raw.flatMap((entry, index) => {
    const data = asRecord(entry);
    if (!data)
      return [];
    const type = readString(data.type) ?? readString(data.name) ?? `limit-${index + 1}`;
    return [{
      id: slug(`${type}-${readNumber(data.unit) ?? "u"}-${readNumber(data.number) ?? index}`),
      type,
      name: readString(data.name),
      unit: readNumber(data.unit),
      number: readNumber(data.number),
      percentage: readNumber(data.percentage),
      used: readFirstNumber(data.usage, data.used),
      limit: readFirstNumber(data.limit, data.total, data.quantity),
      remaining: readNumber(data.remaining),
      currentValue: readNumber(data.currentValue),
      nextResetTime: readNumber(data.nextResetTime),
      usageDetails: parseUsageDetails(data.usageDetails)
    }];
  });
}
function limitToWindow(limit, nowMs) {
  const resetAt = normalizeEpochMs(limit.nextResetTime);
  const standard = {
    id: `zai-${limit.id}`,
    label: labelForLimit(limit),
    kind: kindForLimit(limit),
    ...limit.percentage !== undefined ? { percentage: limit.percentage } : {},
    ...limit.used !== undefined ? { used: limit.used } : {},
    ...limit.limit !== undefined ? { limit: limit.limit } : {},
    ...limit.remaining !== undefined ? { remaining: limit.remaining } : {},
    ...limit.currentValue !== undefined ? { currentValue: limit.currentValue } : {},
    ...resetAt !== undefined ? { resetAt } : {},
    ...limit.type === "TIME_LIMIT" && limit.limit !== undefined ? { budgetLabel: `${limit.limit}s budget` } : {},
    ...limit.type === "TOKENS_LIMIT" ? { unitLabel: "tokens" } : {},
    ...limit.remaining === 0 || (limit.percentage ?? 0) >= 100 ? { limitReached: true } : {},
    additionalProperties: sanitizeAdditionalProperties({ type: limit.type, unit: limit.unit, number: limit.number, nowMs })
  };
  return { ...standard, severity: getWindowSeverity(standard) };
}
function parseUsageDetails(raw) {
  if (!Array.isArray(raw))
    return;
  const details = raw.flatMap((entry) => {
    const data = asRecord(entry);
    const modelCode = data ? readString(data.modelCode) ?? readString(data.model) : undefined;
    if (!data || !modelCode)
      return [];
    return [{
      id: slug(modelCode),
      label: modelCode,
      percentage: readNumber(data.percentage),
      used: readFirstNumber(data.usage, data.used),
      unitLabel: readString(data.unitLabel),
      requests: readNumber(data.requests),
      costUsd: readNumber(data.costUsd)
    }];
  });
  return details.length > 0 ? details : undefined;
}
function labelForLimit(limit) {
  if (limit.unit === 3 && limit.number)
    return `${limit.number}h`;
  if (limit.unit === 6 && limit.number === 1)
    return "day";
  if (limit.unit === 5 && limit.number === 1)
    return "month";
  if (limit.type === "TOKENS_LIMIT")
    return limit.name ?? "tokens";
  return limit.name ?? limit.type.toLowerCase().replace(/_limit$/, "").replace(/_/g, "-");
}
function kindForLimit(limit) {
  if (limit.unit === 3)
    return "rolling";
  if (limit.unit === 6)
    return "daily";
  if (limit.unit === 5)
    return "monthly";
  if (limit.type === "TOKENS_LIMIT")
    return "tokens";
  if (limit.type === "RATE_LIMIT" || limit.type === "TIMES_LIMIT")
    return "requests";
  return "unknown";
}
function readFirstNumber(...values) {
  return values.map(readNumber).find((value) => value !== undefined);
}

// src/providers/registry.ts
var PROVIDER_ADAPTERS = [openAIUsageAdapter, zaiUsageAdapter];
function getActiveAdapters(ctx, config) {
  return PROVIDER_ADAPTERS.filter((adapter) => {
    if (adapter.id === "openai" && !config.show_openai)
      return false;
    if (adapter.id === "zai" && !config.show_zai)
      return false;
    return adapter.isAvailable(ctx);
  });
}
async function refreshAllAdapters(ctx, config, signal) {
  const adapters = getActiveAdapters(ctx, config);
  const results = await Promise.allSettled(adapters.map((adapter) => adapter.fetchUsage(ctx, signal)));
  return Object.fromEntries(results.map((result, index) => {
    const adapter = adapters[index];
    if (!adapter)
      return ["unknown", makeErrorProvider("unknown", "unknown", "missing adapter")];
    if (result.status === "fulfilled")
      return [adapter.id, result.value];
    return [adapter.id, makeErrorProvider(adapter.id, adapter.displayName, sanitizeError(result.reason))];
  }));
}
function makeErrorProvider(id, displayName, message) {
  return {
    id,
    displayName,
    status: "error",
    errorMessage: sanitizeError(message),
    statusText: sanitizeError(message),
    windows: []
  };
}

// src/layout.ts
function sanitizeLine(value) {
  return value.replace(/[\r\n]/g, " ");
}
function truncateTo(value, width) {
  const normalizedWidth = Math.max(0, width);
  const line = sanitizeLine(value);
  if (normalizedWidth <= 0)
    return "";
  if (line.length <= normalizedWidth)
    return line;
  if (normalizedWidth === 1)
    return "\u2026";
  return `${line.slice(0, normalizedWidth - 1)}\u2026`;
}
function truncateSmart(value, width) {
  const normalizedWidth = Math.max(0, width);
  let line = sanitizeLine(value);
  if (line.length <= normalizedWidth)
    return line;
  while (line.includes(" \xB7 ")) {
    const lastSeparator = line.lastIndexOf(" \xB7 ");
    if (lastSeparator <= 0)
      break;
    line = line.slice(0, lastSeparator);
    if (line.length <= normalizedWidth)
      return line;
  }
  return truncateTo(line, normalizedWidth);
}
function padRight(value, width) {
  const normalizedWidth = Math.max(0, width);
  return truncateTo(value, normalizedWidth).padEnd(normalizedWidth, " ");
}
function formatHeaderLine(left, right, width) {
  const normalizedWidth = Math.max(0, width);
  const leftLine = sanitizeLine(left);
  const rightLine = sanitizeLine(right);
  if (normalizedWidth <= 0)
    return "";
  if (rightLine.length >= normalizedWidth)
    return truncateTo(rightLine, normalizedWidth);
  const leftBudget = Math.max(0, normalizedWidth - rightLine.length);
  const safeLeft = leftLine.length > leftBudget ? truncateTo(leftLine, leftBudget) : leftLine;
  const padding = " ".repeat(Math.max(0, normalizedWidth - safeLeft.length - rightLine.length));
  return `${safeLeft}${padding}${rightLine}`;
}
function formatAge(timestampMs, nowMs = Date.now()) {
  const diffMs = nowMs - timestampMs;
  if (diffMs < 0)
    return "now";
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60)
    return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60)
    return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24)
    return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
function formatReset(resetAtMs, nowMs = Date.now()) {
  if (resetAtMs === undefined)
    return "";
  const diffMs = resetAtMs - nowMs;
  if (diffMs <= 0)
    return "reset now";
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 60)
    return `reset ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24)
    return `reset ${hours}h`;
  return `reset ${Math.floor(hours / 24)}d`;
}
function formatPercent(value) {
  if (value === undefined)
    return "";
  return `${Math.round(value)}%`;
}
function formatTokens(count) {
  const abs = Math.abs(count);
  if (abs < 1000)
    return String(count);
  if (abs < 1e6)
    return formatCompact(count, 1000, "K");
  if (abs < 1e9)
    return formatCompact(count, 1e6, "M");
  return formatCompact(count, 1e9, "B");
}
function metricLabelWidth(metrics) {
  const maxLabel = metrics.reduce((max, metric) => Math.max(max, sanitizeLine(metric.label).length), 0);
  return Math.min(10, Math.max(4, maxLabel));
}
function formatMetricLine(label, value, labelWidth, totalWidth) {
  const safeLabel = padRight(label, labelWidth);
  return truncateSmart(`    ${safeLabel}  ${sanitizeLine(value)}`, totalWidth);
}
function formatProviderTitleLine(title, collapsed, summary, width) {
  const indicator = collapsed ? "\u25B6" : "\u25BC";
  const left = `${indicator} ${sanitizeLine(title)}`;
  if (summary === undefined || summary.length === 0)
    return truncateTo(left, width);
  return formatHeaderLine(left, summary, width);
}
function toneToSeverity(tone) {
  if (tone === "warn")
    return "warning";
  if (tone === "bad")
    return "critical";
  if (tone === "muted")
    return "muted";
  return "normal";
}
function formatCompact(value, divisor, suffix) {
  const compact = value / divisor;
  return Number.isInteger(compact) ? `${compact}${suffix}` : `${compact.toFixed(1)}${suffix}`;
}

// src/views/common.ts
function statusView(provider, missingAuthSummary = "needs auth") {
  if (provider.status === "ready" || provider.status === "partial")
    return;
  const summary = provider.status === "missing-auth" ? missingAuthSummary : provider.errorMessage ?? provider.statusText ?? provider.status;
  return {
    id: provider.id,
    title: provider.displayName,
    status: toViewStatus(provider.status),
    summary,
    metrics: [{ key: "status", label: "status", value: summary, tone: "muted", priority: 100, compact: true }],
    fetchedAt: provider.lastGoodAt ?? provider.fetchedAt
  };
}
function toViewStatus(status) {
  if (status === "loading")
    return "partial";
  return status;
}
function windowMetric(window, priority) {
  return {
    key: `window-${window.id}`,
    label: window.label,
    value: windowValue(window),
    tone: severityTone(window.severity ?? getWindowSeverity(window)),
    priority,
    compact: true
  };
}
function windowValue(window) {
  const main = formatPercent(window.percentage) || formatUsedLimit(window) || window.budgetLabel || "n/a";
  const suffix = [window.resetLabel ?? formatReset(window.resetAt)].filter((part) => part !== undefined && part.length > 0);
  return [main, ...suffix].join(" \xB7 ");
}
function splitMetricValue(fullValue) {
  const dotIndex = fullValue.indexOf(" \xB7 ");
  if (dotIndex === -1)
    return { main: fullValue };
  const potentialSuffix = fullValue.slice(dotIndex + 3);
  if (potentialSuffix.startsWith("reset ")) {
    return { main: fullValue.slice(0, dotIndex), suffix: potentialSuffix };
  }
  return { main: fullValue };
}
function metricSummary(metrics, maxCount = 2) {
  const parts = [...metrics].filter((metric) => metric.compact === true && metric.detailOnly !== true).sort((left, right) => right.priority - left.priority).slice(0, maxCount).map((metric) => metric.key === "plan" ? metric.value : `${metric.label} ${metric.value.split(" \xB7 ")[0] ?? metric.value}`);
  return parts.length > 0 ? parts.join(" \xB7 ") : undefined;
}
function stringMetric(key, label, value, priority, options = {}) {
  const formatted = formatUnknown(value);
  if (formatted === undefined || formatted.length === 0)
    return;
  return { key, label, value: formatted, priority, ...options };
}
function formatUnknown(value) {
  if (typeof value === "string")
    return value;
  if (typeof value === "number" && Number.isFinite(value))
    return formatTokens(value);
  if (typeof value === "boolean")
    return value ? "yes" : "no";
  if (Array.isArray(value))
    return `items[${value.length}]`;
  if (value && typeof value === "object")
    return `props[${Object.keys(value).length}]`;
  return;
}
function severityTone(severity) {
  if (severity === "critical")
    return "bad";
  if (severity === "warning")
    return "warn";
  if (severity === "muted")
    return "muted";
  return "good";
}
function formatUsedLimit(window) {
  if (window.used !== undefined && window.limit !== undefined) {
    return `${formatTokens(window.used)}/${formatTokens(window.limit)}${window.unitLabel ? ` ${window.unitLabel}` : ""}`;
  }
  if (window.remaining !== undefined)
    return `${formatTokens(window.remaining)} left`;
  if (window.currentValue !== undefined)
    return `${formatTokens(window.currentValue)} current`;
  return;
}

// src/format.ts
var DEBUG_METRIC_PREFIXES = ["debug-", "raw-"];
var DEBUG_METRIC_KEYS = new Set(["has_credits", "provider-base-url", "debug-provider-base-url", "approx"]);
var COMPACT_SUMMARY_WINDOW_PRIORITY = ["5h", "day", "week", "month"];
function formatProviderTitle(view, collapsed, width) {
  return {
    text: formatProviderTitleLine(view.title, collapsed, collapsed ? view.summary : undefined, width),
    severity: providerTitleSeverity(view)
  };
}
function formatProviderMetricsForState(view, config, width, showDetails) {
  if (!showDetails) {
    const windowMetrics2 = view.metrics.filter((metric) => metric.key.startsWith("window-"));
    const labelWidth2 = metricLabelWidth(windowMetrics2);
    return windowMetrics2.map((metric) => formatMetric(metric, labelWidth2, width));
  }
  const windowMetrics = view.metrics.filter((metric) => metric.key.startsWith("window-"));
  const detailMetrics = [...view.metrics, ...view.details ?? []].filter((metric) => {
    if (metric.key.startsWith("window-"))
      return false;
    if (metric.detailOnly === true && !showDetails)
      return false;
    if (isDebugMetric(metric) && !config.debug)
      return false;
    return true;
  });
  const allVisible = [...windowMetrics, ...detailMetrics];
  const labelWidth = metricLabelWidth(allVisible);
  return allVisible.map((metric) => {
    const isDetail = !metric.key.startsWith("window-");
    const line = formatMetric(metric, labelWidth, width);
    return isDetail ? { ...line, severity: "muted" } : line;
  });
}
function formatCollapsedSummary(view, width) {
  const summary = compactSummary(view.metrics) ?? view.summary ?? view.status;
  return { text: formatProviderTitleLine(view.title, true, summary, width), severity: providerTitleSeverity(view) };
}
function formatHeader(providerCount, right, collapsed, width, symbols) {
  const indicator = collapsed ? symbols === "ascii" ? ">" : "\u25B6" : symbols === "ascii" ? "v" : "\u25BC";
  const headerRight = collapsed ? `${providerCount}p ${right}`.trim() : right;
  return { text: formatHeaderLine(`${indicator} Usage`, headerRight, width), severity: "normal" };
}
function isDebugMetric(metric) {
  return DEBUG_METRIC_KEYS.has(metric.key) || DEBUG_METRIC_KEYS.has(metric.label) || DEBUG_METRIC_PREFIXES.some((prefix) => metric.key.startsWith(prefix));
}
function compactSummary(metrics) {
  const windowMetrics = [...metrics].filter((candidate) => candidate.key.startsWith("window-") && candidate.compact === true && candidate.detailOnly !== true).sort((left, right) => right.priority - left.priority);
  const priorityMetric = COMPACT_SUMMARY_WINDOW_PRIORITY.map((label) => windowMetrics.find((candidate) => candidate.label === label)).find((candidate) => candidate !== undefined);
  const metric = priorityMetric ?? windowMetrics[0];
  if (metric === undefined)
    return;
  const { main } = splitMetricValue(metric.value);
  return `${metric.label} ${main.split(" \xB7 ")[0] ?? main}`;
}
function formatMetric(metric, labelWidth, width) {
  const { main, suffix } = splitMetricValue(metric.value);
  const text = formatMetricLine(metric.label, main, labelWidth, width);
  const suffixBudget = suffix === undefined ? 0 : Math.max(0, width - text.length - 3);
  const visibleSuffix = suffixBudget > 0 && suffix !== undefined ? truncateTo(suffix, suffixBudget) : undefined;
  return {
    text,
    severity: toneToSeverity(metric.tone),
    ...visibleSuffix === undefined ? {} : { suffix: visibleSuffix }
  };
}
function providerTitleSeverity(view) {
  if (view.status === "error")
    return "muted";
  if (view.status === "missing-auth")
    return "muted";
  if (view.status === "stale" || view.stale === true)
    return "muted";
  return "warning";
}

// src/views/openai-view.ts
var DEBUG_KEYS = [
  "creditsApproxLocalMessages",
  "creditsApprox_local_messages",
  "spendControlIndividualLimit",
  "spendControlIndividual_limit",
  "rateLimitResetCreditsHas",
  "rateLimitResetCreditsHas_credits"
];
function openAIProviderToView(provider) {
  const status = statusView(provider);
  if (status)
    return status;
  const metrics = [
    stringMetric("plan", "plan", provider.plan, 100, { compact: true, detailOnly: true }),
    stringMetric("credits", "credits", provider.additionalProperties?.creditsBalance, 90, { compact: true, detailOnly: true }),
    stringMetric("credits-normalized", "credits", provider.additionalProperties?.creditsHas ?? provider.additionalProperties?.creditsHas_credits, 10, { detailOnly: true }),
    ...provider.windows.map((window, index) => windowMetric(window, 80 - index))
  ].filter((metric) => metric !== undefined);
  const details = DEBUG_KEYS.map((key, index) => stringMetric(`debug-${key}`, debugLabel(key), provider.additionalProperties?.[key], 20 - index, { detailOnly: true, tone: "muted" })).filter((metric) => metric !== undefined);
  return {
    id: provider.id,
    title: provider.displayName,
    status: provider.staleAt !== undefined ? "stale" : toViewStatus(provider.status),
    summary: metricSummary(metrics),
    metrics,
    ...details.length > 0 ? { details } : {},
    fetchedAt: provider.lastGoodAt ?? provider.fetchedAt,
    ...provider.staleAt !== undefined ? { stale: true } : {}
  };
}
function debugLabel(key) {
  return key.replace(/^credits/, "").replace(/^spendControl/, "spend").replace(/^rateLimitResetCredits/, "reset").replace(/([a-z])([A-Z])/g, "$1 $2").trim().toLowerCase() || key;
}

// src/views/zai-view.ts
var DETAIL_LABELS = ["search", "tools", "mcp"];
function zaiProviderToView(provider) {
  const status = statusView(provider);
  if (status)
    return status;
  const metrics = [
    stringMetric("plan", "plan", provider.plan, 100, { compact: true, detailOnly: true }),
    ...provider.windows.filter((window) => isKnownWindow(window.label)).map((window) => windowMetric(window, priorityForWindow(window.label)))
  ].filter((metric) => metric !== undefined);
  const detailMetrics = [
    ...DETAIL_LABELS.map((label, index) => stringMetric(`detail-${label}`, label, provider.additionalProperties?.[label], 40 - index, { detailOnly: true })),
    stringMetric("debug-provider-base-url", "base url", provider.additionalProperties?.providerBaseUrl, 1, { detailOnly: true, tone: "muted" })
  ].filter((metric) => metric !== undefined);
  return {
    id: provider.id,
    title: provider.displayName,
    status: provider.staleAt !== undefined ? "stale" : toViewStatus(provider.status),
    summary: metricSummary(metrics),
    metrics,
    ...detailMetrics.length > 0 ? { details: detailMetrics } : {},
    fetchedAt: provider.lastGoodAt ?? provider.fetchedAt,
    ...provider.staleAt !== undefined ? { stale: true } : {}
  };
}
function priorityForWindow(label) {
  if (label === "day")
    return 90;
  if (label === "5h")
    return 80;
  if (label === "month")
    return 70;
  return 50;
}
function isKnownWindow(label) {
  return label === "day" || label === "5h" || label === "month";
}

// src/views/index.ts
function providerToView(provider) {
  if (provider.id === "openai")
    return openAIProviderToView(provider);
  if (provider.id === "zai")
    return zaiProviderToView(provider);
  const status = statusView(provider);
  if (status)
    return status;
  const metrics = [
    stringMetric("plan", "plan", provider.plan, 100, { compact: true }),
    ...provider.windows.map((window, index) => windowMetric(window, 80 - index))
  ].filter((metric) => metric !== undefined);
  return {
    id: provider.id,
    title: provider.displayName,
    status: provider.staleAt !== undefined ? "stale" : toViewStatus(provider.status),
    summary: metricSummary(metrics),
    metrics,
    fetchedAt: provider.lastGoodAt ?? provider.fetchedAt,
    ...provider.staleAt !== undefined ? { stale: true } : {}
  };
}

// src/tui.ts
function element(tag, props, children = []) {
  const node = createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value !== undefined)
      setProp(node, key, value);
  }
  for (const child of children) {
    if (child !== null && child !== undefined && child !== false)
      insert(node, child);
  }
  return node;
}
function text(props, children) {
  return element("text", props, children);
}
function box(props, children = []) {
  return element("box", props, children);
}
function createRefreshGuard() {
  let active = false;
  return {
    get isActive() {
      return active;
    },
    start: () => {
      if (active)
        return false;
      active = true;
      return true;
    },
    finish: () => {
      active = false;
    }
  };
}
function renderUsagePanel(config, providers, collapsed, collapsedProviderIds, expandedDetailIds, onToggleCollapsed, onToggleProvider, onToggleDetails, theme) {
  const width = resolveWidth(config);
  const right = buildHeaderRight(providers);
  const headerLine = formatHeader(Object.keys(providers).length, right, collapsed, width, config.symbols);
  const header = box({ width: "100%", onMouseDown: onToggleCollapsed }, [renderText(headerLine.text, colorForSeverity(headerLine.severity, theme))]);
  if (collapsed || config.enabled === false)
    return renderPanel([header]);
  const rows = orderedProviders(providers).map((provider) => renderProviderBlock(providerToView(provider), config, collapsedProviderIds, expandedDetailIds, onToggleProvider, onToggleDetails, theme));
  return renderPanel([header, ...rows]);
}
function toggleProviderCollapse(current, clicked) {
  if (current.has(clicked)) {
    return new Set([...current].filter((id) => id !== clicked));
  }
  return new Set([...current, clicked]);
}
var toggleExpandedProviderId = toggleProviderCollapse;
function renderProviderBlock(view, config, collapsedProviderIds, expandedDetailIds, onToggleProvider, onToggleDetails, theme) {
  const width = resolveWidth(config);
  const providerCollapsed = collapsedProviderIds.has(view.id);
  if (providerCollapsed) {
    return box({ width: "100%", flexDirection: "column", onMouseDown: () => onToggleProvider(view.id) }, renderLines([formatCollapsedSummary(view, width)], theme));
  }
  const showDetails = expandedDetailIds.has(view.id);
  const titleLine = formatProviderTitle(view, false, width);
  const metrics = formatProviderMetricsForState(view, config, width, showDetails);
  const titleEl = box({ width: "100%", onMouseDown: () => onToggleProvider(view.id) }, renderLines([titleLine], theme));
  const metricEls = metrics.map((line) => box({ width: "100%", onMouseDown: () => onToggleDetails(view.id) }, renderLines([line], theme)));
  return box({ width: "100%", flexDirection: "column" }, [titleEl, ...metricEls]);
}
function renderLines(lines, theme) {
  return lines.map((line) => {
    if (line.suffix) {
      return box({ flexDirection: "row" }, [
        text({ fg: colorForSeverity(line.severity, theme) }, [truncateTo(line.text, line.text.length)]),
        text({ fg: theme.textMuted }, [truncateTo(` \xB7 ${line.suffix}`, line.suffix.length + 3)])
      ]);
    }
    return renderText(line.text, colorForSeverity(line.severity, theme));
  });
}
function renderText(value, color) {
  return text({ fg: color }, [truncateTo(value, value.length)]);
}
function renderPanel(children) {
  return box({ width: "100%", flexDirection: "column", paddingTop: 0, paddingBottom: 0, paddingLeft: 0, paddingRight: 0 }, children);
}
function colorForSeverity(severity, theme) {
  if (severity === "warning")
    return theme.accent;
  if (severity === "critical")
    return theme.error ?? theme.accent;
  if (severity === "muted")
    return theme.textMuted;
  return theme.text;
}
function buildHeaderRight(providers) {
  const timestamps = Object.values(providers).flatMap((provider) => {
    if (provider.fetchedAt !== undefined)
      return [provider.fetchedAt];
    if (provider.lastGoodAt !== undefined)
      return [provider.lastGoodAt];
    return [];
  });
  if (timestamps.length === 0)
    return "";
  const now = Date.now();
  const newest = Math.max(...timestamps);
  return formatAge(newest, now);
}
function orderedProviders(providers) {
  const preferred = ["openai", "zai"];
  return Object.values(providers).sort((left, right) => {
    const leftIndex = preferred.indexOf(left.id);
    const rightIndex = preferred.indexOf(right.id);
    return (leftIndex === -1 ? 99 : leftIndex) - (rightIndex === -1 ? 99 : rightIndex);
  });
}
function resolveWidth(config) {
  return Number.isFinite(config.width) && config.width > 0 ? config.width : CONFIG_DEFAULTS.width;
}
function withPreviousGood(next, previous) {
  return Object.fromEntries(Object.entries(next).map(([id, provider]) => {
    const previousProvider = previous[id];
    if (provider.status !== "error" || previousProvider?.fetchedAt === undefined)
      return [id, provider];
    return [id, { ...provider, lastGoodAt: previousProvider.fetchedAt }];
  }));
}
function markProvidersStale(providers) {
  return Object.fromEntries(Object.entries(providers).map(([id, provider]) => [id, { ...provider, fetchedAt: 0 }]));
}
function envSubset() {
  return {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    ZAI_API_KEY: process.env.ZAI_API_KEY,
    ZAI_CODING_PLAN_API_KEY: process.env.ZAI_CODING_PLAN_API_KEY,
    ZHIPU_API_KEY: process.env.ZHIPU_API_KEY,
    ZHIPUAI_API_KEY: process.env.ZHIPUAI_API_KEY
  };
}
var plugin = {
  id: "usage-monitor:tui",
  tui: async (api, _options, _meta) => {
    const initialConfig = mergeUsageConfig(await readUsageConfig());
    if (initialConfig.enabled === false)
      return;
    const authState = await readAuthFile();
    const auth = authState.kind === "loaded" ? authState.auth : {};
    const [getConfig, setConfig] = createSignal(initialConfig);
    const [getProviders, setProviders] = createSignal({});
    const [getCollapsed, setCollapsed] = createSignal(initialConfig.default_collapsed);
    const [getCollapsedProviderIds, setCollapsedProviderIds] = createSignal(new Set);
    const [getExpandedDetailIds, setExpandedDetailIds] = createSignal(new Set);
    const guard = createRefreshGuard();
    const abortController = new AbortController;
    let pollTimer;
    let configWatcher;
    let fingerprint = configFingerprint(initialConfig);
    let unregisterRefreshCommand;
    let providerCollapseInitialized = false;
    const makeContext = () => ({ auth, env: envSubset(), config: getConfig(), timeoutMs: getConfig().request_timeout_ms });
    const requestRender = () => api.renderer.requestRender();
    const setProvidersWithInitialCollapse = (providers) => {
      setProviders(providers);
      if (providerCollapseInitialized || !getConfig().default_provider_collapsed)
        return;
      providerCollapseInitialized = true;
      setCollapsedProviderIds(new Set(Object.keys(providers)));
    };
    const refreshAll = async () => {
      if (!guard.start())
        return;
      try {
        const config = getConfig();
        const ctx = makeContext();
        const ttlMs = config.refresh_ms;
        const previousProviders = getProviders();
        const cached = readCache();
        if (cached !== null) {
          const freshProviders = filterFreshProviders(cached, ttlMs);
          const activeIds = getActiveAdapters(ctx, config).map((adapter) => adapter.id);
          const allFresh = staleProviderIds(cached, activeIds, ttlMs).length === 0;
          if (allFresh) {
            const providers2 = withPreviousGood(freshProviders, previousProviders);
            setProvidersWithInitialCollapse(providers2);
            requestRender();
            return;
          }
          if (Object.keys(freshProviders).length > 0) {
            setProvidersWithInitialCollapse(withPreviousGood(freshProviders, previousProviders));
            requestRender();
          }
        }
        const providers = withPreviousGood(await refreshAllAdapters(ctx, config, abortController.signal), previousProviders);
        setProvidersWithInitialCollapse(providers);
        writeCache(providers);
      } catch (error) {
        const cached = readCache();
        if (cached && Object.keys(cached).length > 0) {
          setProvidersWithInitialCollapse(cached);
        } else {
          setProvidersWithInitialCollapse({ usage: { id: "usage", displayName: "usage", status: "error", statusText: sanitizeError(error), errorMessage: sanitizeError(error), windows: [] } });
        }
      } finally {
        guard.finish();
        requestRender();
      }
    };
    const restartPoll = () => {
      if (pollTimer !== undefined)
        clearInterval(pollTimer);
      pollTimer = setInterval(() => void refreshAll(), getConfig().refresh_ms);
    };
    const reloadConfig = async () => {
      const nextConfig = mergeUsageConfig(await readUsageConfig());
      const nextFingerprint = configFingerprint(nextConfig);
      if (nextFingerprint === fingerprint)
        return;
      fingerprint = nextFingerprint;
      setConfig(nextConfig);
      restartPoll();
      requestRender();
      refreshAll();
    };
    const debounceConfigReload = createDebounced(() => void reloadConfig(), 100);
    try {
      configWatcher = watch(CONFIG_PATH, () => debounceConfigReload());
    } catch {
      configWatcher = undefined;
    }
    const toggleCollapsed = () => {
      setCollapsed(!getCollapsed());
      requestRender();
    };
    const toggleProvider = (id) => {
      setCollapsedProviderIds(toggleProviderCollapse(getCollapsedProviderIds(), id));
      requestRender();
    };
    const toggleDetails = (id) => {
      const current = getExpandedDetailIds();
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      setExpandedDetailIds(next);
      requestRender();
    };
    restartPoll();
    refreshAll();
    api.lifecycle.onDispose(() => {
      if (pollTimer !== undefined)
        clearInterval(pollTimer);
      debounceConfigReload.cancel();
      configWatcher?.close();
      abortController.abort();
      unregisterRefreshCommand?.();
    });
    api.slots.register({
      order: 840,
      slots: {
        sidebar_content() {
          try {
            return renderUsagePanel(getConfig(), getProviders(), getCollapsed(), getCollapsedProviderIds(), getExpandedDetailIds(), toggleCollapsed, toggleProvider, toggleDetails, api.theme.current);
          } catch (renderErr) {
            const theme = api.theme.current;
            return box({ width: "100%" }, [
              text({ fg: theme.error ?? theme.textMuted }, [`usage-monitor render error: ${String(renderErr).slice(0, 80)}`])
            ]);
          }
        }
      }
    });
    unregisterRefreshCommand = api.command?.register(() => [{
      title: "Refresh Usage Data",
      value: "usage-monitor:refresh",
      description: "Force refresh usage data from all providers",
      category: "usage-monitor",
      keybind: getConfig().refresh_keybind,
      slash: { name: "usage-refresh" },
      onSelect: async (_dialog) => {
        try {
          const cachedProviders = readCache();
          if (cachedProviders !== null)
            writeCache(markProvidersStale(cachedProviders));
          await refreshAll();
          api.ui.toast({ title: "Usage Monitor", message: "Usage data refreshed", variant: "success", duration: 2000 });
        } catch (error) {
          api.ui.toast({ title: "Usage Monitor", message: `Usage data refresh failed: ${sanitizeError(error)}`, variant: "error", duration: 2000 });
        }
      }
    }]);
  }
};
function createDebounced(callback, delayMs) {
  let timer;
  const debounced = () => {
    if (timer !== undefined)
      clearTimeout(timer);
    timer = setTimeout(callback, delayMs);
  };
  debounced.cancel = () => {
    if (timer !== undefined)
      clearTimeout(timer);
    timer = undefined;
  };
  return debounced;
}
var tui_default = plugin;
export {
  toggleProviderCollapse,
  toggleExpandedProviderId,
  renderUsagePanel,
  tui_default as default,
  createRefreshGuard
};
