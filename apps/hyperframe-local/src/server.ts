import http from "node:http";
import sharp from "sharp";

const DEFAULT_WIDTH = 1920;
const DEFAULT_HEIGHT = 1080;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const PORT = Number(process.env.HYPERFRAME_PORT ?? 8791);
const HOST = process.env.HYPERFRAME_HOST ?? "127.0.0.1";

type JsonRecord = Record<string, unknown>;

interface RenderRequest {
  width?: number;
  height?: number;
  title?: string;
  chartSpec?: JsonRecord | null;
}

const server = http.createServer(async (request, response) => {
  try {
    setCorsHeaders(response);

    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${HOST}:${PORT}`}`);

    if (request.method === "GET" && url.pathname === "/health") {
      writeJson(response, 200, {
        ok: true,
        service: "hyperframe-local",
        mode: "svg-sharp",
        supportedTypes: [
          "singleWindowHighlightCard",
          "multiWindowComparisonCards",
          "returnBarComparison",
          "stabilityDiagnosticCards"
        ]
      });
      return;
    }

    if (request.method !== "POST" || url.pathname !== "/render") {
      writeJson(response, 404, { ok: false, error: "Not found" });
      return;
    }

    const body = await readJsonBody<RenderRequest>(request);
    const width = clampInteger(body.width, 640, 4096, DEFAULT_WIDTH);
    const height = clampInteger(body.height, 360, 4096, DEFAULT_HEIGHT);
    const chartSpec = isRecord(body.chartSpec) ? body.chartSpec : {};
    const title = sanitizeVisibleText(typeof body.title === "string" ? body.title : getString(chartSpec, "title", "案例复盘"));
    const svg = renderSvg({
      width,
      height,
      title,
      chartSpec
    });
    const png = await sharp(Buffer.from(svg)).resize(width, height, { fit: "cover" }).png().toBuffer();

    response.writeHead(200, {
      "content-type": "image/png",
      "content-length": String(png.byteLength),
      "cache-control": "no-store"
    });
    response.end(png);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeJson(response, message.includes("too large") ? 413 : 500, {
      ok: false,
      error: message
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`hyperframe-local listening on http://${HOST}:${PORT}`);
});

function renderSvg(input: { width: number; height: number; title: string; chartSpec: JsonRecord }) {
  const type = getString(input.chartSpec, "type", getString(input.chartSpec, "chartType", "generic"));
  const body =
    type === "singleWindowHighlightCard"
      ? renderSingleWindow(input.title, input.chartSpec)
      : type === "multiWindowComparisonCards"
        ? renderMultiWindow(input.title, input.chartSpec)
        : type === "returnBarComparison"
          ? renderReturnBars(input.title, input.chartSpec)
          : type === "stabilityDiagnosticCards"
            ? renderStabilityDiagnostics(input.title, input.chartSpec)
            : renderGenericCard(input.title, input.chartSpec);

  return `<svg width="${input.width}" height="${input.height}" viewBox="0 0 1920 1080" xmlns="http://www.w3.org/2000/svg">
  <rect width="1920" height="1080" fill="#f6f8fb"/>
  <path d="M0 0h1920v1080H0z" fill="#f6f8fb"/>
  <rect x="72" y="64" width="1776" height="952" rx="28" fill="#ffffff" stroke="#d9e1ec" stroke-width="2"/>
  <rect x="96" y="88" width="1728" height="88" rx="16" fill="#111827"/>
  <text x="128" y="144" font-family="${fontFamily()}" font-size="36" font-weight="700" fill="#ffffff">${escapeXml(input.title)}</text>
  <text x="1690" y="144" text-anchor="end" font-family="${fontFamily()}" font-size="24" font-weight="700" fill="#8bd3ff">CryptoPathX</text>
  ${body}
</svg>`;
}

function renderSingleWindow(title: string, spec: JsonRecord) {
  const primary = firstSeriesRecord(spec);
  const market = sanitizeVisibleText(getString(spec, "market", getString(spec, "symbolLabel", "比特币案例")));
  const displayReturn = sanitizeVisibleText(
    getString(
      spec,
      "displayReturn",
      getString(primary, "displayReturn", formatReturnLabel(getNumber(primary, "returnPct", getNumber(primary, "totalReturnPct", null))))
    )
  );
  const winRate = getNumber(spec, "winRatePct", getNumber(primary, "winRatePct", null));
  const drawdown = getNumber(
    spec,
    "maxDrawdownPct",
    getNumber(spec, "drawdownPct", getNumber(primary, "maxDrawdownPct", getNumber(primary, "drawdownPct", null)))
  );
  const trades = getNumber(spec, "tradeCount", getNumber(spec, "trades", getNumber(primary, "tradeCount", getNumber(primary, "trades", null))));
  const period = sanitizeVisibleText(getString(spec, "period", getString(spec, "window", getString(primary, "label", "一段完整行情"))));
  const subtitle = sanitizeVisibleText(
    getString(spec, "summary", "同一套规则放在真实行情里复盘，先看结果，再追问过程是否稳。")
  );

  return `
  ${pill(128, 206, 210, "案例窗口", "#e0f2fe", "#0369a1")}
  ${textBlock(128, 322, market, 48, 1, "#111827", 720, 700)}
  ${textBlock(128, 396, period, 30, 1, "#64748b", 720, 400)}
  <rect x="128" y="456" width="760" height="360" rx="22" fill="#f8fafc" stroke="#dbe4ef" stroke-width="2"/>
  <text x="172" y="548" font-family="${fontFamily()}" font-size="38" font-weight="700" fill="#334155">这一段跑出来的结果</text>
  <text x="172" y="660" font-family="${fontFamily()}" font-size="86" font-weight="800" fill="${displayReturn.includes("亏") ? "#dc2626" : "#059669"}">${escapeXml(displayReturn)}</text>
  ${textBlock(172, 736, subtitle, 30, 2, "#475569", 660, 400)}
  ${metricCard(960, 246, "交易次数", trades === null ? "看样本量" : `${Math.round(trades)} 次`, "#2563eb")}
  ${metricCard(1290, 246, "胜率", winRate === null ? "看分布" : `${Math.round(winRate)}% 左右`, "#7c3aed")}
  ${metricCard(960, 506, "最大回撤", drawdown === null ? "重点观察" : formatDrawdownLabel(drawdown), "#dc2626")}
  ${metricCard(1290, 506, "复盘重点", "别只看收益", "#f59e0b")}
  ${bottomNote("这张卡只展示复盘信息，不构成投资建议。")}
  ${hiddenTitleComment(title)}`;
}

function renderMultiWindow(title: string, spec: JsonRecord) {
  const series = normalizeSeries(spec);
  const summary = sanitizeVisibleText(
    getString(spec, "summary", getString(spec, "displaySpread", "同一套规则在不同市场阶段的表现差别很大。"))
  );
  const cards = series.slice(0, 3).map((item, index) => {
    const x = 128 + index * 560;
    const color = item.returnPct === null || item.returnPct >= 0 ? "#059669" : "#dc2626";
    return `
      <rect x="${x}" y="350" width="500" height="410" rx="22" fill="#f8fafc" stroke="#dbe4ef" stroke-width="2"/>
      ${textBlock(x + 34, 422, item.label, 32, 2, "#111827", 430, 700)}
      <text x="${x + 34}" y="548" font-family="${fontFamily()}" font-size="58" font-weight="800" fill="${color}">${escapeXml(item.displayReturn)}</text>
      ${miniMetric(x + 34, 612, "交易", item.trades === null ? "看样本" : `${Math.round(item.trades)} 次`)}
      ${miniMetric(x + 244, 612, "胜率", item.winRatePct === null ? "看分布" : `${Math.round(item.winRatePct)}% 左右`)}
      ${miniMetric(x + 34, 684, "回撤", item.drawdownPct === null ? "重点看" : formatDrawdownLabel(item.drawdownPct))}
    `;
  });

  return `
  ${pill(128, 206, 230, "多阶段对比", "#dcfce7", "#166534")}
  ${textBlock(128, 310, "同一套方法，换一段行情再看", 44, 1, "#111827", 1000, 700)}
  ${cards.join("")}
  <rect x="128" y="778" width="1640" height="120" rx="20" fill="#fff7ed" stroke="#fed7aa" stroke-width="2"/>
  ${textBlock(170, 848, summary, 34, 2, "#9a3412", 1530, 700)}
  ${bottomNote("看回测案例时，最重要的是跨阶段稳定性，而不是单个漂亮窗口。")}
  ${hiddenTitleComment(title)}`;
}

function renderReturnBars(title: string, spec: JsonRecord) {
  const bars = normalizeBars(spec);
  const maxAbs = Math.max(...bars.map((bar) => Math.abs(bar.value)), 1);
  const zeroY = 705;
  const chartTop = 260;
  const chartBottom = 835;
  const plotHeight = chartBottom - chartTop;
  const scale = Math.min(360 / maxAbs, plotHeight / maxAbs);
  const renderedBars = bars.slice(0, 5).map((bar, index) => {
    const slot = 320;
    const barWidth = 170;
    const x = 240 + index * slot;
    const height = Math.max(8, Math.abs(bar.value) * scale);
    const y = bar.value >= 0 ? zeroY - height : zeroY;
    const color = bar.value >= 0 ? "#10b981" : "#ef4444";
    const labelY = bar.value >= 0 ? y + 52 : y + height + 48;
    const labelColor = bar.value >= 0 ? "#ffffff" : color;
    return `
      <rect x="${x}" y="${y}" width="${barWidth}" height="${height}" rx="14" fill="${color}"/>
      <text x="${x + barWidth / 2}" y="${labelY}" text-anchor="middle" font-family="${fontFamily()}" font-size="28" font-weight="800" fill="${labelColor}">${escapeXml(bar.display)}</text>
      ${textBlock(x - 80, 902, bar.label, 24, 2, "#334155", 300, 700, "middle", x + barWidth / 2)}
    `;
  });

  return `
  ${pill(128, 206, 210, "收益对比", "#eef2ff", "#4338ca")}
  ${textBlock(128, 318, "别只看一段行情，要把好坏阶段摆在一起", 44, 1, "#111827", 1320, 700)}
  <line x1="170" y1="${zeroY}" x2="1740" y2="${zeroY}" stroke="#94a3b8" stroke-width="3"/>
  <text x="1780" y="${zeroY + 10}" font-family="${fontFamily()}" font-size="24" fill="#64748b">0</text>
  ${renderedBars.join("")}
  <rect x="1290" y="352" width="420" height="230" rx="20" fill="#f8fafc" stroke="#dbe4ef" stroke-width="2"/>
  ${textBlock(1330, 420, "读图重点", 32, 1, "#111827", 330, 700)}
  ${textBlock(1330, 486, "同一策略在顺风、逆风、震荡阶段的差异，通常比单个收益数字更有参考价值。", 28, 4, "#475569", 340, 400)}
  ${bottomNote("图表为案例复盘表达，具体交易决策仍需结合个人风险承受能力。")}
  ${hiddenTitleComment(title)}`;
}

function renderStabilityDiagnostics(title: string, spec: JsonRecord) {
  const cards = normalizeDiagnosticCards(spec);
  const renderedCards = cards.slice(0, 4).map((card, index) => {
    const x = index % 2 === 0 ? 128 : 986;
    const y = index < 2 ? 388 : 644;
    return `
      <rect x="${x}" y="${y}" width="782" height="196" rx="22" fill="#f8fafc" stroke="#dbe4ef" stroke-width="2"/>
      ${textBlock(x + 36, y + 66, card.title, 32, 1, "#111827", 700, 700)}
      <text x="${x + 36}" y="${y + 126}" font-family="${fontFamily()}" font-size="44" font-weight="800" fill="${card.color}">${escapeXml(card.value)}</text>
      ${textBlock(x + 36, y + 174, card.note, 26, 1, "#64748b", 700, 400)}
    `;
  });

  return `
  ${pill(128, 206, 220, "稳定性体检", "#fee2e2", "#991b1b")}
  ${textBlock(128, 318, "一个策略能不能用，要先过这几道检查", 44, 1, "#111827", 1250, 700)}
  ${renderedCards.join("")}
  ${bottomNote("这类检查的目的，是把看似漂亮的收益拆开看清楚。")}
  ${hiddenTitleComment(title)}`;
}

function renderGenericCard(title: string, spec: JsonRecord) {
  const lines = Object.entries(spec)
    .filter(([, value]) => ["string", "number", "boolean"].includes(typeof value))
    .slice(0, 5)
    .map(([key, value]) => `${key}: ${String(value)}`);
  const content = sanitizeVisibleText(lines.length ? lines.join(" / ") : "这是一张通用信息卡，用来承载当前段落的视觉说明。");

  return `
  ${pill(128, 220, 200, "信息卡", "#e0f2fe", "#0369a1")}
  ${textBlock(128, 306, title, 48, 2, "#111827", 1400, 700)}
  <rect x="128" y="454" width="1500" height="310" rx="22" fill="#f8fafc" stroke="#dbe4ef" stroke-width="2"/>
  ${textBlock(172, 550, content, 36, 4, "#334155", 1400, 400)}
  ${bottomNote("本地 Hyperframe 兼容渲染器")}
  `;
}

function normalizeSeries(spec: JsonRecord) {
  const raw = getArray(spec, "series").length
    ? getArray(spec, "series")
    : getArray(spec, "windows").length
      ? getArray(spec, "windows")
      : getArray(spec, "items");
  const fallback = [
    { label: "顺风阶段", returnPct: 130, trades: 23, winRatePct: 48, drawdownPct: -40 },
    { label: "逆风阶段", returnPct: -45, trades: 21, winRatePct: 24, drawdownPct: -47 },
    { label: "震荡阶段", returnPct: -27, trades: 11, winRatePct: 18, drawdownPct: -30 }
  ];
  const items = raw.length ? raw : fallback;

  return items.map((item, index) => {
    const record = isRecord(item) ? item : {};
    const returnPct = getNumber(record, "returnPct", getNumber(record, "totalReturnPct", null));
    return {
      label: sanitizeVisibleText(
        getString(record, "label", getString(record, "period", getString(record, "window", fallback[index]?.label ?? `阶段 ${index + 1}`)))
      ),
      returnPct,
      displayReturn: sanitizeVisibleText(getString(record, "displayReturn", formatReturnLabel(returnPct))),
      trades: getNumber(record, "trades", getNumber(record, "tradeCount", null)),
      winRatePct: getNumber(record, "winRatePct", null),
      drawdownPct: getNumber(record, "drawdownPct", getNumber(record, "maxDrawdownPct", null))
    };
  });
}

function firstSeriesRecord(spec: JsonRecord) {
  const series = getArray(spec, "series");
  const first = series[0];
  return isRecord(first) ? first : {};
}

function normalizeBars(spec: JsonRecord) {
  const raw = getArray(spec, "bars").length ? getArray(spec, "bars") : getArray(spec, "series");
  const source = raw.length ? raw : normalizeSeries(spec);
  return source.map((item, index) => {
    const record = isRecord(item) ? item : {};
    const value = getNumber(record, "value", getNumber(record, "returnPct", getNumber(record, "totalReturnPct", 0))) ?? 0;
    return {
      label: sanitizeVisibleText(
        getString(record, "label", getString(record, "period", getString(record, "window", `阶段 ${index + 1}`)))
      ),
      value,
      display: sanitizeVisibleText(getString(record, "display", getString(record, "displayReturn", formatReturnLabel(value))))
    };
  });
}

function normalizeDiagnosticCards(spec: JsonRecord) {
  const raw = getArray(spec, "cards").length
    ? getArray(spec, "cards")
    : getArray(spec, "diagnostics").length
      ? getArray(spec, "diagnostics")
      : [];
  if (raw.length) {
    return raw.map((item, index) => {
      const record = isRecord(item) ? item : {};
      return {
        title: sanitizeVisibleText(getString(record, "title", `检查 ${index + 1}`)),
        value: sanitizeVisibleText(getString(record, "value", getString(record, "displayValue", "需要关注"))),
        note: sanitizeVisibleText(getString(record, "note", getString(record, "description", "看它对结果的影响。"))),
        color: ["#dc2626", "#2563eb", "#7c3aed", "#f59e0b"][index % 4]
      };
    });
  }

  const drawdownRange = sanitizeVisibleText(getString(spec, "drawdownRange", "30%左右 到 接近47%"));
  const concentration = sanitizeVisibleText(getString(spec, "profitConcentration", "70%多"));
  const sampleSize = sanitizeVisibleText(getString(spec, "sampleSize", "样本偏少"));
  return [
    { title: "回撤压力", value: drawdownRange, note: "先看自己扛不扛得住。", color: "#dc2626" },
    { title: "利润集中度", value: concentration, note: "收益是否集中在少数机会。", color: "#7c3aed" },
    { title: "样本数量", value: sampleSize, note: "样本太少就别急着下结论。", color: "#2563eb" },
    { title: "跨阶段表现", value: "差异明显", note: "顺风和逆风要分开看。", color: "#f59e0b" }
  ];
}

function metricCard(x: number, y: number, label: string, value: string, color: string) {
  return `
  <rect x="${x}" y="${y}" width="290" height="210" rx="20" fill="#f8fafc" stroke="#dbe4ef" stroke-width="2"/>
  <text x="${x + 28}" y="${y + 68}" font-family="${fontFamily()}" font-size="28" font-weight="700" fill="#64748b">${escapeXml(label)}</text>
  ${textBlock(x + 28, y + 136, value, 38, 2, color, 230, 800)}
  `;
}

function miniMetric(x: number, y: number, label: string, value: string) {
  return `
  <text x="${x}" y="${y}" font-family="${fontFamily()}" font-size="22" font-weight="700" fill="#64748b">${escapeXml(label)}</text>
  <text x="${x}" y="${y + 38}" font-family="${fontFamily()}" font-size="30" font-weight="800" fill="#334155">${escapeXml(value)}</text>
  `;
}

function pill(x: number, y: number, width: number, label: string, fill: string, color: string) {
  return `
  <rect x="${x}" y="${y}" width="${width}" height="50" rx="25" fill="${fill}"/>
  <text x="${x + width / 2}" y="${y + 34}" text-anchor="middle" font-family="${fontFamily()}" font-size="24" font-weight="800" fill="${color}">${escapeXml(label)}</text>
  `;
}

function bottomNote(note: string) {
  return `
  <line x1="128" y1="944" x2="1792" y2="944" stroke="#e2e8f0" stroke-width="2"/>
  <text x="128" y="982" font-family="${fontFamily()}" font-size="24" fill="#64748b">${escapeXml(note)}</text>
  `;
}

function hiddenTitleComment(title: string) {
  return `<desc>${escapeXml(title)}</desc>`;
}

function textBlock(
  x: number,
  y: number,
  value: string,
  fontSize: number,
  maxLines: number,
  color: string,
  maxWidth: number,
  weight: number,
  anchor: "start" | "middle" = "start",
  anchorX?: number
) {
  const maxUnits = Math.max(4, Math.floor(maxWidth / fontSize));
  const lines = wrapText(sanitizeVisibleText(value), maxUnits, maxLines);
  const lineHeight = Math.round(fontSize * 1.28);
  const textX = anchor === "middle" && typeof anchorX === "number" ? anchorX : x;
  const tspans = lines
    .map((line, index) => `<tspan x="${textX}" dy="${index === 0 ? 0 : lineHeight}">${escapeXml(line)}</tspan>`)
    .join("");
  return `<text x="${textX}" y="${y}" text-anchor="${anchor}" font-family="${fontFamily()}" font-size="${fontSize}" font-weight="${weight}" fill="${color}">${tspans}</text>`;
}

function wrapText(value: string, maxUnits: number, maxLines: number) {
  const chars = Array.from(value.replace(/\s+/g, " ").trim());
  const lines: string[] = [];
  let current = "";
  let units = 0;

  for (const char of chars) {
    const charUnits = /[\x00-\x7F]/.test(char) ? 0.55 : 1;
    if (units + charUnits > maxUnits && current) {
      lines.push(current.trim());
      current = "";
      units = 0;
      if (lines.length >= maxLines) {
        break;
      }
    }
    current += char;
    units += charUnits;
  }

  if (current.trim() && lines.length < maxLines) {
    lines.push(current.trim());
  }

  if (lines.length > 0 && lines.length === maxLines && chars.length > lines.join("").length) {
    lines[lines.length - 1] = `${lines[lines.length - 1].replace(/[，。；、,.!?！？\s]+$/, "")}...`;
  }

  return lines.length ? lines : [""];
}

function sanitizeVisibleText(value: string) {
  return value
    .replace(/BTCUSDT/gi, "比特币")
    .replace(/MongoDB|collection|database|数据库|VerifiedCasePack|CaseIntent|ReviewAgent/gi, "")
    .replace(/\+?133\.45%/g, "130%多")
    .replace(/178\.55\s*个百分点/g, "差不多两倍")
    .replace(/\s+/g, " ")
    .trim();
}

function formatReturnLabel(value: number | null) {
  if (value === null || Number.isNaN(value)) {
    return "看阶段表现";
  }
  const abs = Math.round(Math.abs(value));
  if (value > 0) {
    return `赚了${abs}%多`;
  }
  if (value < 0) {
    return `亏了${abs}%左右`;
  }
  return "基本打平";
}

function formatDrawdownLabel(value: number) {
  const abs = Math.round(Math.abs(value));
  if (abs >= 45) {
    return `接近 ${abs}%`;
  }
  return `${abs}% 左右`;
}

function getString(record: JsonRecord, key: string, fallback: string) {
  const value = record[key];
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return fallback;
}

function getNumber(record: JsonRecord, key: string, fallback: number | null) {
  const value = record[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.replace(/%/g, ""));
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

function getArray(record: JsonRecord, key: string) {
  const value = record[key];
  return Array.isArray(value) ? value : [];
}

function clampInteger(value: unknown, min: number, max: number, fallback: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.round(value)));
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonBody<T>(request: http.IncomingMessage) {
  const chunks: Buffer[] = [];
  let bytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_BODY_BYTES) {
      throw new Error("Request body is too large.");
    }
    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {} as T;
  }

  return JSON.parse(raw) as T;
}

function writeJson(response: http.ServerResponse, status: number, payload: unknown) {
  const body = Buffer.from(JSON.stringify(payload, null, 2), "utf8");
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.byteLength),
    "cache-control": "no-store"
  });
  response.end(body);
}

function setCorsHeaders(response: http.ServerResponse) {
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type");
}

function escapeXml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function fontFamily() {
  return "Microsoft YaHei, Noto Sans SC, Arial, sans-serif";
}
