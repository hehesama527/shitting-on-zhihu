import crypto from "node:crypto";
import { MongoClient } from "mongodb";
import type {
  VideoCaseIntentRequest,
  VideoCaseIntentSummary,
  VideoCaseStrategyConfig,
  VideoVerifiedCasePack
} from "@zhihu-mvp/shared";
import { getAppConfig } from "../config/env.js";
import type { VideoRepository } from "./video-repository.js";

type Kline = {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteAssetVolume: number;
  trades: number;
};

type Trade = {
  entryTime: string;
  entrySignalTime: string;
  entryPriceRaw: number;
  entryPriceWithCost: number;
  entryRegime: "trend" | "transition" | "range_or_chop";
  cashBefore: number;
  qty: number;
  exitSignalTime: string;
  exitTime: string;
  exitPriceRaw: number;
  exitPriceWithCost: number;
  cashAfter: number;
  pnl: number;
  returnPct: number;
  forcedExitAtWindowEnd?: boolean;
};

type ReplayResult = {
  finalCapital: number;
  returnPct: number;
  tradeCount: number;
  winRatePct: number;
  grossProfit: number;
  grossLoss: number;
  maxDrawdownPct: number;
  maxDrawdownPoint: Record<string, unknown> | null;
  top3WinningTradesContributionToGrossProfitPct: number;
  lossByEntryRegime: Record<string, number>;
  trades: Trade[];
  equityCurve: Array<{ timestamp: string; equity: number }>;
};

export class VideoCaseService {
  constructor(private readonly repository: VideoRepository) {}

  async createCaseIntent(projectId: string, input: VideoCaseIntentRequest) {
    return this.repository.createCaseIntent(projectId, normalizeCaseIntentRequest(input));
  }

  async generateVerifiedCasePack(projectId: string, caseIntentId?: string | null) {
    const intent = caseIntentId
      ? await this.repository.getCaseIntent(caseIntentId)
      : (await this.repository.listProjectCaseIntents(projectId))[0] ?? null;
    if (!intent || intent.projectId !== projectId) {
      throw new Error("Video case intent not found.");
    }

    await this.repository.updateCaseIntentStatus(intent.id, "evidence_running");

    try {
      const pack = await this.buildPackFromMongoIntent(intent);
      await this.repository.updateCaseIntentStatus(
        intent.id,
        pack.status === "failed" || pack.status === "insufficient_evidence" ? "review_failed" : "evidence_ready",
        pack.status === "failed" || pack.status === "insufficient_evidence"
          ? pack.review.findings.join("\n")
          : null
      );
      return this.repository.createVerifiedCasePack({
        projectId,
        caseIntentId: intent.id,
        pack,
        errorMessage:
          pack.status === "failed" || pack.status === "insufficient_evidence"
            ? pack.review.findings.join("\n")
            : null
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.repository.updateCaseIntentStatus(intent.id, "review_failed", message);
      throw error;
    }
  }

  async listCaseIntents(projectId: string) {
    return this.repository.listProjectCaseIntents(projectId);
  }

  async listVerifiedCasePacks(projectId: string) {
    return this.repository.listProjectVerifiedCasePacks(projectId);
  }

  private async buildPackFromMongoIntent(intent: VideoCaseIntentSummary): Promise<VideoVerifiedCasePack> {
    const config = getAppConfig();
    if (config.videoCaseDataSource !== "cryptopathx_mongo" || intent.dataSource !== "cryptopathx_mongo") {
      throw new Error("Only cryptopathx_mongo video case data source is supported in the MVP.");
    }
    if (config.videoCaseAllowExternalBinanceFallback) {
      throw new Error("External Binance fallback is intentionally not implemented for video case review.");
    }

    const collectionName = intent.collectionName || config.videoCaseMongoKlineCollection || `${intent.symbol}_${intent.interval}`;
    const mongo = new MongoClient(config.videoCaseMongoUri, {
      serverSelectionTimeoutMS: 5_000
    });
    try {
      await mongo.connect();
      const rows = await mongo
        .db(config.videoCaseMongoDb)
        .collection(collectionName)
        .find({
          timestamp: {
            $gte: new Date(intent.startTime),
            $lt: new Date(intent.endTime)
          }
        })
        .sort({ timestamp: 1 })
        .toArray();
      const klines = rows.map((row) => normalizeMongoKline(row));
      const quality = inspectKlineQuality(klines, intent.interval);
      const rawHash = crypto
        .createHash("sha256")
        .update(JSON.stringify(klines.map(stableKlineForHash)))
        .digest("hex");
      const replay =
        klines.length >= intent.strategyParams.slowWindow + 2
          ? replaySmaCrossover(klines, intent.strategyParams, intent.assumptions)
          : null;
      const status = resolvePackStatus(klines.length, quality, replay);
      const caseId = buildCaseId(intent, rawHash);
      const metrics = replay
        ? {
            finalCapital: round2(replay.finalCapital),
            returnPct: round2(replay.returnPct),
            tradeCount: replay.tradeCount,
            winRatePct: round2(replay.winRatePct),
            grossProfit: round2(replay.grossProfit),
            grossLoss: round2(replay.grossLoss),
            maxDrawdownPct: round2(replay.maxDrawdownPct),
            maxDrawdownPoint: replay.maxDrawdownPoint,
            top3WinningTradesContributionToGrossProfitPct: round2(
              replay.top3WinningTradesContributionToGrossProfitPct
            ),
            lossByEntryRegime: Object.fromEntries(
              Object.entries(replay.lossByEntryRegime).map(([key, value]) => [key, round2(value)])
            )
          }
        : {};
      const dataSource = {
        kind: "mongodb",
        database: config.videoCaseMongoDb,
        collection: collectionName,
        symbol: intent.symbol,
        interval: intent.interval,
        query: {
          timestamp: {
            $gte: intent.startTime,
            $lt: intent.endTime
          }
        },
        rowCount: klines.length,
        rawDataSha256: rawHash,
        fieldMapping: {
          time: "timestamp",
          open: "open",
          high: "high",
          low: "low",
          close: "close",
          volume: "volume",
          quoteVolume: "quote_asset_volume",
          trades: "trades"
        },
        normalization: "string/float OHLCV fields normalized to number before strategy replay",
        qualityChecks: quality
      };
      const strategy = {
        name: "SMA fast/slow long-only crossover",
        params: intent.strategyParams,
        rules: [
          "spot long only, no short, no leverage",
          "signal uses closed candle only",
          "entry executes at next candle open after fast SMA crosses above slow SMA",
          "exit executes at next candle open after fast SMA crosses below slow SMA",
          "if still open at window end, position is closed at final close for reporting"
        ],
        assumptions: intent.assumptions
      };
      const review = buildDeterministicReview(intent, status, metrics, quality);
      return {
        caseId,
        status,
        createdAt: new Date().toISOString(),
        dataSource,
        caseIntent: {
          id: intent.id,
          projectId: intent.projectId,
          requestedCase: intent.requestJson.requestedCase ?? "",
          notes: intent.requestJson.notes ?? ""
        },
        strategy,
        metrics,
        review,
        chartData: {
          equityCurve: replay ? sampleSeries(replay.equityCurve, 120) : [],
          trades: replay ? replay.trades.map(stripInternalTradeFields) : []
        }
      };
    } finally {
      await mongo.close();
    }
  }
}

function normalizeCaseIntentRequest(input: VideoCaseIntentRequest): VideoCaseIntentRequest {
  return {
    ...input,
    dataSource: input.dataSource ?? "cryptopathx_mongo",
    symbol: input.symbol.toUpperCase(),
    strategy: {
      name: input.strategy?.name ?? "sma_crossover",
      fastWindow: input.strategy?.fastWindow ?? 20,
      slowWindow: input.strategy?.slowWindow ?? 60,
      side: input.strategy?.side ?? "long_only"
    },
    assumptions: {
      initialCapital: input.assumptions?.initialCapital ?? 10_000,
      feeBpsEachSide: input.assumptions?.feeBpsEachSide ?? 10,
      slippageBpsEachSide: input.assumptions?.slippageBpsEachSide ?? 5
    }
  };
}

function normalizeMongoKline(row: Record<string, unknown>): Kline {
  const timestamp = row.timestamp instanceof Date ? row.timestamp : new Date(String(row.timestamp));
  return {
    timestamp: timestamp.toISOString(),
    open: toNumber(row.open, "open"),
    high: toNumber(row.high, "high"),
    low: toNumber(row.low, "low"),
    close: toNumber(row.close, "close"),
    volume: toNumber(row.volume ?? 0, "volume"),
    quoteAssetVolume: toNumber(row.quote_asset_volume ?? 0, "quote_asset_volume"),
    trades: Number(row.trades ?? 0)
  };
}

function toNumber(value: unknown, field: string) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric ${field} value in Mongo kline.`);
  }
  return parsed;
}

function stableKlineForHash(row: Kline) {
  return {
    timestamp: row.timestamp,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume,
    quoteAssetVolume: row.quoteAssetVolume,
    trades: row.trades
  };
}

function inspectKlineQuality(rows: Kline[], interval: string) {
  const intervalMs = intervalToMs(interval);
  const seen = new Set<string>();
  let duplicateTimestamps = 0;
  let gapCount = 0;
  let ohlcErrorCount = 0;
  const gaps: Array<{ from: string; to: string; deltaMs: number }> = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (seen.has(row.timestamp)) {
      duplicateTimestamps += 1;
    }
    seen.add(row.timestamp);
    if (index > 0 && intervalMs) {
      const previous = Date.parse(rows[index - 1].timestamp);
      const current = Date.parse(row.timestamp);
      const deltaMs = current - previous;
      if (deltaMs !== intervalMs) {
        gapCount += 1;
        gaps.push({
          from: rows[index - 1].timestamp,
          to: row.timestamp,
          deltaMs
        });
      }
    }
    if (
      row.high < Math.max(row.open, row.close, row.low) ||
      row.low > Math.min(row.open, row.close, row.high)
    ) {
      ohlcErrorCount += 1;
    }
  }
  return {
    duplicateTimestamps,
    gapCount,
    ohlcErrorCount,
    firstTimestamp: rows[0]?.timestamp ?? null,
    lastTimestamp: rows[rows.length - 1]?.timestamp ?? null,
    gaps: gaps.slice(0, 20)
  };
}

function intervalToMs(interval: string) {
  const match = /^(\d+)(m|h|d)$/i.exec(interval.trim());
  if (!match) {
    return null;
  }
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (unit === "m") {
    return value * 60_000;
  }
  if (unit === "h") {
    return value * 60 * 60_000;
  }
  return value * 24 * 60 * 60_000;
}

function sma(values: number[], window: number) {
  const result: Array<number | null> = Array(values.length).fill(null);
  let sum = 0;
  for (let index = 0; index < values.length; index += 1) {
    sum += values[index];
    if (index >= window) {
      sum -= values[index - window];
    }
    if (index >= window - 1) {
      result[index] = sum / window;
    }
  }
  return result;
}

function replaySmaCrossover(
  rows: Kline[],
  strategy: VideoCaseStrategyConfig,
  assumptions: { initialCapital: number; feeBpsEachSide: number; slippageBpsEachSide: number }
): ReplayResult {
  const closes = rows.map((row) => row.close);
  const fast = sma(closes, strategy.fastWindow);
  const slow = sma(closes, strategy.slowWindow);
  const costRate = (assumptions.feeBpsEachSide + assumptions.slippageBpsEachSide) / 10_000;
  let cash = assumptions.initialCapital;
  let qty = 0;
  let entry: Omit<Trade, "exitSignalTime" | "exitTime" | "exitPriceRaw" | "exitPriceWithCost" | "cashAfter" | "pnl" | "returnPct"> | null = null;
  const trades: Trade[] = [];

  for (let index = strategy.slowWindow; index < rows.length - 1; index += 1) {
    const previousFast = fast[index - 1];
    const previousSlow = slow[index - 1];
    const currentFast = fast[index];
    const currentSlow = slow[index];
    if (previousFast === null || previousSlow === null || currentFast === null || currentSlow === null) {
      continue;
    }

    const crossUp = previousFast <= previousSlow && currentFast > currentSlow;
    const crossDown = previousFast >= previousSlow && currentFast < currentSlow;
    const executionRow = rows[index + 1];

    if (qty <= 0 && crossUp) {
      const entryPriceWithCost = executionRow.open * (1 + costRate);
      qty = cash / entryPriceWithCost;
      entry = {
        entryTime: executionRow.timestamp,
        entrySignalTime: rows[index].timestamp,
        entryPriceRaw: executionRow.open,
        entryPriceWithCost,
        entryRegime: classifyEntryRegime(rows[index].close, currentFast, currentSlow),
        cashBefore: cash,
        qty
      };
      cash = 0;
      continue;
    }

    if (qty > 0 && crossDown && entry) {
      const exitPriceWithCost = executionRow.open * (1 - costRate);
      cash = qty * exitPriceWithCost;
      const pnl = cash - entry.cashBefore;
      trades.push({
        ...entry,
        exitSignalTime: rows[index].timestamp,
        exitTime: executionRow.timestamp,
        exitPriceRaw: executionRow.open,
        exitPriceWithCost,
        cashAfter: cash,
        pnl,
        returnPct: (pnl / entry.cashBefore) * 100
      });
      qty = 0;
      entry = null;
    }
  }

  if (qty > 0 && entry) {
    const finalRow = rows[rows.length - 1];
    const exitPriceWithCost = finalRow.close * (1 - costRate);
    cash = qty * exitPriceWithCost;
    const pnl = cash - entry.cashBefore;
    trades.push({
      ...entry,
      exitSignalTime: finalRow.timestamp,
      exitTime: finalRow.timestamp,
      exitPriceRaw: finalRow.close,
      exitPriceWithCost,
      cashAfter: cash,
      pnl,
      returnPct: (pnl / entry.cashBefore) * 100,
      forcedExitAtWindowEnd: true
    });
  }

  const equityCurve = buildEquityCurve(rows, trades, assumptions.initialCapital);
  const drawdown = computeMaxDrawdown(equityCurve);
  const wins = trades.filter((trade) => trade.pnl > 0);
  const losses = trades.filter((trade) => trade.pnl <= 0);
  const grossProfit = wins.reduce((sum, trade) => sum + trade.pnl, 0);
  const grossLoss = losses.reduce((sum, trade) => sum + trade.pnl, 0);
  const top3GrossProfit = [...wins]
    .sort((a, b) => b.pnl - a.pnl)
    .slice(0, 3)
    .reduce((sum, trade) => sum + trade.pnl, 0);
  const lossByEntryRegime: Record<string, number> = {};
  for (const trade of losses) {
    lossByEntryRegime[trade.entryRegime] = (lossByEntryRegime[trade.entryRegime] ?? 0) + trade.pnl;
  }

  return {
    finalCapital: cash,
    returnPct: (cash / assumptions.initialCapital - 1) * 100,
    tradeCount: trades.length,
    winRatePct: trades.length ? (wins.length / trades.length) * 100 : 0,
    grossProfit,
    grossLoss,
    maxDrawdownPct: drawdown.maxDrawdownPct,
    maxDrawdownPoint: drawdown.maxDrawdownPoint,
    top3WinningTradesContributionToGrossProfitPct: grossProfit ? (top3GrossProfit / grossProfit) * 100 : 0,
    lossByEntryRegime,
    trades,
    equityCurve
  };
}

function classifyEntryRegime(close: number, fast: number, slow: number): Trade["entryRegime"] {
  if (close > slow && fast > slow) {
    return "trend";
  }
  if (Math.abs(fast - slow) / slow < 0.03) {
    return "transition";
  }
  return "range_or_chop";
}

function buildEquityCurve(rows: Kline[], trades: Trade[], initialCapital: number) {
  const entries = new Map(trades.map((trade) => [trade.entryTime, trade]));
  const exits = new Map(trades.map((trade) => [trade.exitTime, trade]));
  let cash = initialCapital;
  let qty = 0;
  const equityCurve: Array<{ timestamp: string; equity: number }> = [];
  for (const row of rows) {
    const entry = entries.get(row.timestamp);
    if (entry) {
      cash = 0;
      qty = entry.qty;
    }
    equityCurve.push({
      timestamp: row.timestamp,
      equity: qty > 0 ? qty * row.close : cash
    });
    const exit = exits.get(row.timestamp);
    if (exit) {
      cash = exit.cashAfter;
      qty = 0;
      equityCurve[equityCurve.length - 1] = {
        timestamp: row.timestamp,
        equity: cash
      };
    }
  }
  return equityCurve;
}

function computeMaxDrawdown(equityCurve: Array<{ timestamp: string; equity: number }>) {
  let peak = 0;
  let maxDrawdownPct = 0;
  let maxDrawdownPoint: Record<string, unknown> | null = null;
  for (const point of equityCurve) {
    peak = Math.max(peak, point.equity);
    const drawdownPct = peak > 0 ? (point.equity / peak - 1) * 100 : 0;
    if (drawdownPct < maxDrawdownPct) {
      maxDrawdownPct = drawdownPct;
      maxDrawdownPoint = {
        timestamp: point.timestamp,
        drawdownPct,
        equity: point.equity,
        peak
      };
    }
  }
  return { maxDrawdownPct, maxDrawdownPoint };
}

function resolvePackStatus(
  rowCount: number,
  quality: ReturnType<typeof inspectKlineQuality>,
  replay: ReplayResult | null
): VideoVerifiedCasePack["status"] {
  if (!replay || rowCount === 0) {
    return "insufficient_evidence";
  }
  if (quality.duplicateTimestamps > 0 || quality.gapCount > 0 || quality.ohlcErrorCount > 0) {
    return "ready_with_warnings";
  }
  return "ready";
}

function buildDeterministicReview(
  intent: VideoCaseIntentSummary,
  status: VideoVerifiedCasePack["status"],
  metrics: Record<string, unknown>,
  quality: ReturnType<typeof inspectKlineQuality>
): VideoVerifiedCasePack["review"] {
  const warnings: string[] = [];
  if (quality.gapCount > 0) {
    warnings.push(`Kline gap count is ${quality.gapCount}.`);
  }
  if (quality.duplicateTimestamps > 0) {
    warnings.push(`Duplicate timestamp count is ${quality.duplicateTimestamps}.`);
  }
  if (quality.ohlcErrorCount > 0) {
    warnings.push(`OHLC error count is ${quality.ohlcErrorCount}.`);
  }
  if (status === "insufficient_evidence") {
    warnings.push("Not enough rows to replay the requested strategy.");
  }

  const returnPct = formatMetric(metrics.returnPct);
  const tradeCount = formatMetric(metrics.tradeCount);
  const winRatePct = formatMetric(metrics.winRatePct);
  const maxDrawdownPct = formatMetric(metrics.maxDrawdownPct);
  const top3 = formatMetric(metrics.top3WinningTradesContributionToGrossProfitPct);
  return {
    allowedFacts: [
      `本地 MongoDB 数据窗口为 ${intent.symbol} ${intent.interval}，从 ${intent.startTime} 到 ${intent.endTime}。`,
      `策略规则是 SMA${intent.strategyParams.fastWindow}/SMA${intent.strategyParams.slowWindow} 多头交叉，只做多，不做空，不使用杠杆。`,
      `信号使用已闭合 K 线，下一根 ${intent.interval} K 线开盘执行。`,
      `成本假设为初始资金 ${intent.assumptions.initialCapital} USDT，单边 ${intent.assumptions.feeBpsEachSide}bps 手续费和 ${intent.assumptions.slippageBpsEachSide}bps 滑点。`,
      ...(returnPct ? [`该窗口复验收益为 ${returnPct}%。`] : []),
      ...(tradeCount ? [`交易笔数为 ${tradeCount} 笔，胜率为 ${winRatePct}%。`] : []),
      ...(maxDrawdownPct ? [`按逐 K 线盯市口径估算，最大权益回撤约 ${maxDrawdownPct}%。`] : []),
      ...(top3 ? [`前三笔盈利贡献总盈利的 ${top3}%。`] : [])
    ],
    findings: [
      status === "ready" ? "数据质量检查通过，未发现重复时间戳、K 线缺口或 OHLC 异常。" : "数据质量或样本量存在警告，需要在脚本中明确说明。",
      "窗口收益为正不等于策略有效，只说明该规则在该窗口和成本假设下跑出该结果。",
      "样本交易笔数有限，不能支撑强结论。",
      "盈利集中度较高时，需要额外做跨窗口和参数扰动复验。"
    ],
    hypotheses: [
      "下一步应做跨年份、跨交易对、不同成本和参数扰动测试。",
      "亏损结构可作为复盘入口，但不能把粗分类直接写成确定归因。"
    ],
    forbiddenClaims: [
      "该策略有效",
      "可以据此买入",
      "收益可以复制",
      "AI 已经找到赚钱策略",
      "CryptoPathX 可以保证收益或自动交易"
    ],
    contentSafety: {
      mustSay: [
        "这是历史复验案例，不构成投资建议。",
        "单窗口正收益不能证明策略有效。",
        "真实使用前需要更多样本、更多窗口和人工确认。"
      ]
    },
    reviewScore: status === "ready" ? 88 : status === "ready_with_warnings" ? 70 : 35,
    warnings
  };
}

function buildCaseId(intent: VideoCaseIntentSummary, hash: string) {
  const start = intent.startTime.slice(0, 10).replace(/-/g, "");
  const end = intent.endTime.slice(0, 10).replace(/-/g, "");
  return `case_${intent.symbol.toLowerCase()}_${intent.interval}_${start}_${end}_${intent.strategyParams.name}_${hash.slice(0, 8)}`;
}

function sampleSeries<T>(items: T[], maxItems: number) {
  if (items.length <= maxItems) {
    return items;
  }
  const step = Math.ceil(items.length / maxItems);
  return items.filter((_, index) => index % step === 0);
}

function stripInternalTradeFields(trade: Trade) {
  const { qty: _qty, ...rest } = trade;
  return Object.fromEntries(
    Object.entries(rest).map(([key, value]) => [key, typeof value === "number" ? round4(value) : value])
  );
}

function formatMetric(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? String(round2(value)) : "";
}

function round2(value: number) {
  return Math.round(value * 100) / 100;
}

function round4(value: number) {
  return Math.round(value * 10_000) / 10_000;
}
