
const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const router = express.Router();
require("dotenv").config();

const OpenAI = require("openai");

let openaiClient;

function getOpenAIClient() {
  if (!process.env.RUNO_API_KEY) {
    throw new Error("Не задан OPENAI_API_KEY в файле .env");
  }

  if (!openaiClient) {
    openaiClient = new OpenAI({
      apiKey: process.env.RUNO_API_KEY
    });
  }

  return openaiClient;
}

const DATA_DIR = path.join(__dirname, "..", "data");
const DATA_FILE = path.join(DATA_DIR, "meta-ads.json");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const allowed = /\.csv$/i.test(file.originalname || "");
    cb(allowed ? null : new Error("Загрузите CSV-файл Meta Ads"), allowed);
  },
});

function readDatabase() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));

   return {
  ads: Array.isArray(parsed.ads) ? parsed.ads : [],
  imports: Array.isArray(parsed.imports) ? parsed.imports : [],
  history: Array.isArray(parsed.history) ? parsed.history : [],
  aiHistory: Array.isArray(parsed.aiHistory) ? parsed.aiHistory : []
};
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        ads: [],
        imports: [],
        history: [],
        aiHistory: []
      };
    }

    throw error;
  }
}

function writeDatabase(database) {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const temp = `${DATA_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`;

  fs.writeFileSync(
    temp,
    JSON.stringify(database, null, 2),
    "utf8"
  );

  fs.renameSync(temp, DATA_FILE);
}

function normalizeHeader(value) {
  return String(value || "")
    .replace(/^\uFEFF/, "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("ru-RU");
}

function parseCsv(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] || "";
  const commas = (firstLine.match(/,/g) || []).length;
  const semicolons = (firstLine.match(/;/g) || []).length;

  const delimiter = semicolons > commas ? ";" : ",";

  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (char === '"') {
      if (quoted && text[i + 1] === '"') {
        value += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (char === delimiter && !quoted) {
      row.push(value);
      value = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[i + 1] === "\n") i++;

      row.push(value);

      if (row.some(cell => String(cell).trim())) {
        rows.push(row);
      }

      row = [];
      value = "";
    } else {
      value += char;
    }
  }

  row.push(value);

  if (row.some(cell => String(cell).trim())) {
    rows.push(row);
  }

  if (rows.length < 2) {
    throw new Error("В CSV нет объявлений");
  }

  const headers = rows[0].map(normalizeHeader);

  return rows.slice(1).map(cells => {
    const record = {};

    headers.forEach((header, index) => {
      record[header] = String(cells[index] ?? "").trim();
    });

    return record;
  });
}

function getField(row, aliases) {
  for (const alias of aliases) {
    const key = normalizeHeader(alias);

    if (Object.prototype.hasOwnProperty.call(row, key)) {
      return row[key];
    }
  }

  return "";
}

function numberValue(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  let cleaned = String(value)
    .replace(/[\u00a0\u202f\s]/g, "")
    .replace(/[^\d,.\-]/g, "");

  if (!cleaned) return null;

  if (cleaned.includes(",") && !cleaned.includes(".")) {
    cleaned = cleaned.replace(",", ".");
  } else {
    cleaned = cleaned.replace(/,/g, "");
  }

  const result = Number(cleaned);

  return Number.isFinite(result) ? result : null;
}

function getNumber(row, aliases) {
  return numberValue(getField(row, aliases));
}

function makeAd(row) {
  const name = getField(row, [
    "Название объявления",
    "Ad name",
    "Ad"
  ]);

  if (!name) return null;

  const adSet = getField(row, [
    "Название группы объявлений",
    "Ad set name"
  ]);

  const campaign = getField(row, [
    "Название кампании",
    "Campaign name"
  ]);

  const metaAdId = getField(row, [
    "Ид объявления",
    "ID объявления",
    "Ad ID"
  ]);

  const spend = getNumber(row, [
    "Потраченная сумма (USD)",
    "Amount spent (USD)",
    "Amount spent"
  ]) ?? 0;

  const impressions = getNumber(row, ["Показы", "Impressions"]) ?? 0;
  const reach = getNumber(row, ["Охват", "Reach"]) ?? 0;
  const frequency = getNumber(row, ["Частота", "Frequency"]) ?? 0;

  const clicks = getNumber(row, [
    "Клики (все)",
    "Clicks (all)"
  ]) ?? 0;

  const linkClicks = getNumber(row, [
    "Клики по ссылке",
    "Link clicks"
  ]) ?? 0;

  const conversations = getNumber(row, [
    "Начата переписка",
    "Messaging conversations started"
  ]) ?? 0;

  const ctr = getNumber(row, [
    "CTR (все)",
    "CTR (all)"
  ]);

  const cpc = getNumber(row, [
    "CPC (все) (USD)",
    "CPC (all) (USD)",
    "CPC (all)"
  ]);

  const cpm = getNumber(row, [
    "CPM (цена за 1 000 показов) (USD)",
    "CPM (USD)",
    "CPM"
  ]);

  const conversationCost = getNumber(row, [
    "Цена за начатую переписку в приложении (USD)",
    "Cost per messaging conversation started (USD)"
  ]);

  const delivery = getField(row, [
    "Показ рекламы",
    "Delivery"
  ]).toLowerCase();

  const metaStatus =
    delivery === "active" || delivery === "активно"
      ? "active"
      : delivery === "inactive" || delivery === "неактивно"
        ? "inactive"
        : "unknown";

  const purchases = getNumber(row, ["Покупки", "Purchases"]);
  const revenue = getNumber(row, [
    "Ценность конверсий покупки",
    "Purchase conversion value"
  ]);

  const hash = crypto
    .createHash("sha1")
    .update(`${name}|${adSet}|${campaign}`)
    .digest("hex")
    .slice(0, 16);

  const sourceKey = metaAdId
    ? `meta:${metaAdId}`
    : `csv:${hash}`;

  const startDate = getField(row, [
    "Дата начала отчетности",
    "Reporting starts"
  ]);

  const endDate = getField(row, [
    "Окончание отчетности",
    "Reporting ends"
  ]);

  const currency = "USD";

  return {
    id: metaAdId || `CSV-${hash.slice(0, 8).toUpperCase()}`,
    sourceKey,
    metaAdId: metaAdId || null,

    name,
    campaign: campaign || adSet || "Meta Ads",
    adSet,

    status: "Новые",
    metaStatus,

    spend,
    impressions,
    reach,
    frequency,

    clicks,
    linkClicks,
    conversations,

    conversationCost:
      conversationCost ??
      (conversations > 0 ? spend / conversations : null),

    ctr,
    cpc,
    cpm,

    qualified: null,
    sales: purchases,
    revenue,

    creative: null,
    performance: null,

    currency,

    reportStart: startDate || null,
    reportEnd: endDate || null,
    granularity: "period",

    videoViews: getNumber(row, [
      "3-секундные воспроизведения видео"
    ]),

    video25: getNumber(row, [
      "Воспроизведения видео до точки 25 %"
    ]),

    video50: getNumber(row, [
      "Воспроизведения видео до точки 50 %"
    ]),

    video75: getNumber(row, [
      "Воспроизведения видео до точки 75 %"
    ]),

    video95: getNumber(row, [
      "Воспроизведения видео до точки 95 %"
    ]),

    video100: getNumber(row, [
      "Воспроизведения видео до точки 100 %"
    ]),

    updatedAt: new Date().toISOString(),

    note: "Импортировано из Meta Ads CSV. Оценки AI пока не рассчитаны."
  };
}

// Безопасное преобразование числа
function metricNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const number = Number(value);

  return Number.isFinite(number) ? number : null;
}

// Расчёт показателей одного объявления
function calculateMetrics(ad) {
  const spend = metricNumber(ad.spend);
  const impressions = metricNumber(ad.impressions);
  const reach = metricNumber(ad.reach);
  const clicks = metricNumber(ad.clicks);
  const conversations = metricNumber(ad.conversations);

  const ctr = metricNumber(ad.ctr);
  const cpc = metricNumber(ad.cpc);
  const cpm = metricNumber(ad.cpm);
  const conversationCost = metricNumber(ad.conversationCost);

  return {
    spend,

    impressions,
    reach,

    frequency:
      impressions !== null && reach > 0
        ? impressions / reach
        : metricNumber(ad.frequency),

    clicks,
    linkClicks: metricNumber(ad.linkClicks),

    conversations,

    ctr:
      ctr !== null
        ? ctr
        : impressions > 0 && clicks !== null
          ? (clicks / impressions) * 100
          : null,

    cpc:
      cpc !== null
        ? cpc
        : spend !== null && clicks > 0
          ? spend / clicks
          : null,

    cpm:
      cpm !== null
        ? cpm
        : spend !== null && impressions > 0
          ? (spend / impressions) * 1000
          : null,

    conversationCost:
      conversationCost !== null
        ? conversationCost
        : spend !== null && conversations > 0
          ? spend / conversations
          : null,

    clickToConversationRate:
      clicks > 0 && conversations !== null
        ? (conversations / clicks) * 100
        : null,

    sales: metricNumber(ad.sales),
    revenue: metricNumber(ad.revenue)
  };
}

// Снимок показателей для истории
function createHistorySnapshot(ad) {
  return {
    spend: metricNumber(ad.spend),
    impressions: metricNumber(ad.impressions),
    reach: metricNumber(ad.reach),
    clicks: metricNumber(ad.clicks),
    linkClicks: metricNumber(ad.linkClicks),
    conversations: metricNumber(ad.conversations),
    conversationCost: metricNumber(ad.conversationCost),
    ctr: metricNumber(ad.ctr),
    cpc: metricNumber(ad.cpc),
    cpm: metricNumber(ad.cpm),
    sales: metricNumber(ad.sales),
    revenue: metricNumber(ad.revenue)
  };
}

// Аналитика всех объявлений с относительной оценкой
function buildAnalytics(ads) {
  const prepared = ads.map(ad => ({
    ...ad,
    analytics: calculateMetrics(ad)
  }));

  // Для оценки используем объявления с минимум 3 переписками
  const comparable = prepared.filter(ad =>
    ad.analytics.spend > 0 &&
    ad.analytics.conversations >= 3 &&
    ad.analytics.conversationCost !== null
  );

  prepared.forEach(ad => {
    const cost = ad.analytics.conversationCost;

    let performanceScore = null;

    if (comparable.length >= 3 && cost !== null &&
        ad.analytics.conversations >= 3) {

      const better = comparable.filter(
        item => item.analytics.conversationCost > cost
      ).length;

      const equal = comparable.filter(
        item => item.analytics.conversationCost === cost
      ).length;

      performanceScore =
        Math.round(
          ((better + (equal - 1) / 2) /
            (comparable.length - 1)) * 100
        );
    }

    ad.analytics.performanceScore = performanceScore;

    ad.analytics.scoreBasis =
      performanceScore === null
        ? "Недостаточно сопоставимых объявлений"
        : "Сравнение стоимости переписки внутри аккаунта";

    ad.analytics.profitabilityAvailable =
      ad.analytics.revenue !== null &&
      ad.analytics.revenue > 0;
  });

  return prepared;
}

router.get("/", (_req, res) => {
  try {
    const database = readDatabase();

    res.json({
      success: true,
      ads: database.ads,
      imports: database.imports.slice(0, 20)
    });
  } catch (error) {
    console.error("Meta Ads read error:", error);

    res.status(500).json({
      success: false,
      message: "Ошибка чтения Meta Ads"
    });
  }
});

// GET /api/meta-ads/analytics
// Общая аналитика всех объявлений
router.get("/analytics", (_req, res) => {
  try {
    const database = readDatabase();

    const ads = buildAnalytics(database.ads);

    const sum = field =>
      ads.reduce(
        (total, ad) =>
          total + (metricNumber(ad.analytics[field]) ?? 0),
        0
      );

    const totalSpend = sum("spend");
    const totalConversations = sum("conversations");
    const totalImpressions = sum("impressions");
    const totalClicks = sum("clicks");
    const totalSales = sum("sales");

    const overview = {
      adsCount: ads.length,

      totalSpend,
      totalConversations,
      totalImpressions,
      totalClicks,
      totalSales,

      averageConversationCost:
        totalConversations > 0
          ? totalSpend / totalConversations
          : null,

      averageCtr:
        totalImpressions > 0
          ? (totalClicks / totalImpressions) * 100
          : null,

      averageCpm:
        totalImpressions > 0
          ? (totalSpend / totalImpressions) * 1000
          : null,

      currency:
        ads.find(ad => ad.currency)?.currency || null,

      historyCount: database.history.length,
      importsCount: database.imports.length
    };

    return res.json({
      success: true,
      overview,
      ads,
      lastImport: database.imports[0] || null
    });

  } catch (error) {
    console.error("Meta Ads analytics error:", error);

    return res.status(500).json({
      success: false,
      message: "Ошибка расчёта аналитики"
    });
  }
});

// POST /api/meta-ads/ai/analyze
// Реальный AI-анализ объявлений через OpenAI
router.post("/ai/analyze", async (_req, res) => {
  try {
    const database = readDatabase();

    if (!database.ads.length) {
      return res.status(400).json({
        success: false,
        message: "Сначала импортируйте объявления Meta Ads"
      });
    }

    // Отправляем модели только необходимые рекламные показатели
    const ads = database.ads.slice(0, 80).map(ad => {
      const metrics = calculateMetrics(ad);

      return {
        id: ad.id,
        name: ad.name,
        campaign: ad.campaign,
        manualKanbanStatus: ad.status,
        metaDeliveryStatus: ad.metaStatus,

        reportStart: ad.reportStart || null,
        reportEnd: ad.reportEnd || null,

        currency: ad.currency || null,

        spend: metrics.spend,
        impressions: metrics.impressions,
        reach: metrics.reach,
        frequency: metrics.frequency,

        clicks: metrics.clicks,
        linkClicks: metrics.linkClicks,
        ctr: metrics.ctr,
        cpc: metrics.cpc,
        cpm: metrics.cpm,

        conversations: metrics.conversations,
        conversationCost: metrics.conversationCost,
        clickToConversationRate: metrics.clickToConversationRate,

        qualified: metricNumber(ad.qualified),
        sales: metrics.sales,
        revenue: metrics.revenue
      };
    });

    const payload = {
      business: "Постельное бельё и домашний текстиль",
      market: "Кыргызстан",
      advertisingChannels: [
        "Instagram Direct",
        "Facebook Messenger"
      ],
      currency: "USD",
      adsCount: ads.length,
      ads
    };

    const response = await getOpenAIClient().responses.create({
      model: process.env.OPENAI_MODEL || "gpt-6-luna",

      instructions: `
Ты — опытный аналитик Meta Ads.
Анализируешь рекламу интернет-магазина постельного белья
и домашнего текстиля в Кыргызстане.

Твоя задача — объективно анализировать рекламные показатели.

ОБЯЗАТЕЛЬНЫЕ ПРАВИЛА:

1. Используй только данные, переданные в запросе.
2. Не выдумывай показатели, продажи, прибыль и выручку.
3. null означает, что данных нет. Это не означает ноль.
4. Не объявляй объявление успешным только из-за дешёвой переписки.
5. Учитывай CTR, CPC, CPM, стоимость переписки,
   количество переписок и конверсию кликов в переписки.
6. Сравнивай объявления осторожно. Учитывай периоды отчётности.
   Если периоды разные или выборка мала — укажи ограничение.
7. Не называй дорогую переписку автоматически убыточной.
   Для этого нужны данные о продажах, марже и прибыли.
8. Не делай вывод о качестве визуального креатива,
   если у тебя нет изображения или видео.
9. Не придумывай универсальные нормы стоимости переписки.
10. Давай конкретные рекомендации, объясняя их причину.
11. Не меняй бюджеты, статусы, настройки или этапы Kanban.
    Ты только анализируешь и советуешь.
12. Отвечай на русском языке.
13. Если данных недостаточно, честно напиши об этом.

Вердикты:
- сильное
- среднее
- слабое
- недостаточно данных

Не путай Creative Score с Performance Score.
По CSV-метрикам нельзя достоверно оценить визуальную привлекательность.
`,

      input: JSON.stringify(payload),

      text: {
        format: {
          type: "json_schema",
          name: "meta_ads_analysis",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              overallSummary: {
                type: "string"
              },
              accountFindings: {
                type: "array",
                items: { type: "string" }
              },
              warnings: {
                type: "array",
                items: { type: "string" }
              },
              ads: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    id: { type: "string" },
                    verdict: {
                      type: "string",
                      enum: [
                        "сильное",
                        "среднее",
                        "слабое",
                        "недостаточно данных"
                      ]
                    },
                    confidence: {
                      type: "string",
                      enum: [
                        "низкая",
                        "средняя",
                        "высокая"
                      ]
                    },
                    explanation: {
                      type: "string"
                    },
                    evidence: {
                      type: "array",
                      items: { type: "string" }
                    },
                    recommendations: {
                      type: "array",
                      items: { type: "string" }
                    }
                  },
                  required: [
                    "id",
                    "verdict",
                    "confidence",
                    "explanation",
                    "evidence",
                    "recommendations"
                  ]
                }
              }
            },
            required: [
              "overallSummary",
              "accountFindings",
              "warnings",
              "ads"
            ]
          }
        }
      },

      max_output_tokens: 8000,
      store: false
    });

    if (!response.output_text) {
      throw new Error("OpenAI не вернул текст анализа");
    }

    if (!response.output_text) {
  throw new Error("OpenAI вернул пустой ответ");
}

let analysis;

try {
  analysis = JSON.parse(response.output_text);
} catch (parseError) {
  console.error("JSON PARSE ERROR:", parseError.message);
  console.error("OpenAI response status:", response.status);
  console.error("OpenAI response text:", response.output_text);

  throw new Error(
    "AI вернул некорректный JSON. Возможно, ответ был обрезан."
  );
}

  const result = {
  success: true,
  id: crypto.randomUUID(),
  model: process.env.OPENAI_MODEL || "gpt-6-luna",
  analyzedAt: new Date().toISOString(),
  adsAnalyzed: ads.length,
  analysis,
  usage: response.usage || null
};

// Сохраняем AI-анализ в отдельную историю
database.aiHistory.unshift(result);

// Храним последние 100 анализов
database.aiHistory = database.aiHistory.slice(0, 100);

// Записываем в JSON
writeDatabase(database);

return res.json(result);

  } catch (error) {
 throw new Error("Не задан OPENAI_API_KEY в файле .env");
    const status =
      error.status === 401 ? 502 :
      error.status === 429 ? 429 :
      500;

    let message = "Не удалось выполнить AI-анализ";

    if (error.status === 401) {
      message = "Проверьте API-ключ OpenAI";
    } else if (error.status === 429) {
      message = "Лимит API или баланс исчерпан. Проверьте Billing OpenAI";
    } else if (error.message?.includes("OPENAI_API_KEY")) {
      message = error.message;
    }

    return res.status(status).json({
      success: false,
      message
    });
  }
});

// GET /api/meta-ads/ai/history
// Получить историю AI-анализов
router.get("/ai/history", (_req, res) => {
  try {
    const database = readDatabase();

    return res.json({
      success: true,
      count: database.aiHistory.length,
      history: database.aiHistory
    });
  } catch (error) {
    console.error("AI history read error:", error);

    return res.status(500).json({
      success: false,
      message: "Не удалось получить историю AI-анализов"
    });
  }
});

// GET /api/meta-ads/ai/history/:id
// Получить один сохранённый анализ
router.get("/ai/history/:id", (req, res) => {
  try {
    const database = readDatabase();

    const item = database.aiHistory.find(
      entry => String(entry.id) === String(req.params.id)
    );

    if (!item) {
      return res.status(404).json({
        success: false,
        message: "AI-анализ не найден"
      });
    }

    return res.json({
      success: true,
      item
    });
  } catch (error) {
    console.error("AI history item error:", error);

    return res.status(500).json({
      success: false,
      message: "Не удалось получить AI-анализ"
    });
  }
});

// POST /api/meta-ads/ai/history/import
// Добавить ранее выполненный AI-анализ в историю
router.post("/ai/history/import", (req, res) => {
  try {
    const incoming = req.body;

    if (
      !incoming ||
      incoming.success !== true ||
      !incoming.analysis ||
      !Array.isArray(incoming.analysis.ads)
    ) {
      return res.status(400).json({
        success: false,
        message: "Некорректный формат AI-анализа"
      });
    }

    const database = readDatabase();

    // Защита от повторного добавления одного анализа
    const alreadyExists = database.aiHistory.some(item =>
      item.analyzedAt === incoming.analyzedAt &&
      item.model === incoming.model
    );

    if (alreadyExists) {
      return res.json({
        success: true,
        duplicate: true,
        message: "Этот анализ уже есть в истории"
      });
    }

    const record = {
      success: true,
      id: crypto.randomUUID(),
      model: incoming.model || "unknown",
      analyzedAt: incoming.analyzedAt || new Date().toISOString(),
      adsAnalyzed: incoming.adsAnalyzed ?? incoming.analysis.ads.length,
      analysis: incoming.analysis,
      usage: incoming.usage || null
    };

    database.aiHistory.unshift(record);
    database.aiHistory = database.aiHistory.slice(0, 100);

    writeDatabase(database);

    return res.json({
      success: true,
      message: "Старый AI-анализ добавлен в историю",
      item: record
    });
  } catch (error) {
    console.error("AI history import error:", error);

    return res.status(500).json({
      success: false,
      message: "Не удалось сохранить старый AI-анализ"
    });
  }
});

router.post("/import", upload.single("file"), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Выберите CSV-файл"
      });
    }

    const text = req.file.buffer
      .toString("utf8")
      .replace(/^\uFEFF/, "");

    const rows = parseCsv(text);

    const imported = rows
      .map(makeAd)
      .filter(ad =>
        ad &&
        (
          ad.metaStatus === "active" ||
          ad.spend > 0 ||
          ad.impressions > 0
        )
      );

    if (!imported.length) {
      return res.status(400).json({
        success: false,
        message: "Не найдены рекламные объявления"
      });
    }

    const database = readDatabase();

    const existingByKey = new Map(
      database.ads.map(ad => [ad.sourceKey || ad.id, ad])
    );

    let created = 0;
    let updated = 0;

    for (const incoming of imported) {
      const existing = existingByKey.get(incoming.sourceKey);

      if (existing) {
        const oldStatus = existing.status;
        const oldCreatedAt = existing.createdAt;

        Object.assign(existing, incoming, {
          status: oldStatus || "Новые",
          createdAt: oldCreatedAt || incoming.updatedAt
        });

        updated++;
      } else {
        incoming.createdAt = incoming.updatedAt;

        database.ads.push(incoming);
        existingByKey.set(incoming.sourceKey, incoming);

        created++;
      }
    }

const report = {
  id: crypto.randomUUID(),
  fileName: req.file.originalname,
  importedAt: new Date().toISOString(),

  rows: imported.length,
  sourceRows: rows.length,
  skipped: rows.length - imported.length,

  created,
  updated,

  reportStart:
    imported.find(ad => ad.reportStart)?.reportStart || null,

  reportEnd:
    imported.find(ad => ad.reportEnd)?.reportEnd || null,

  hasAdIds: imported.every(ad => Boolean(ad.metaAdId)),
  granularity: "period"
};

// Сохраняем снимки показателей каждого объявления
const newHistory = [];

for (const incoming of imported) {
  const savedAd = existingByKey.get(incoming.sourceKey);

  if (!savedAd) continue;

  const metrics = createHistorySnapshot(savedAd);

  const fingerprint = crypto
    .createHash("sha1")
    .update(JSON.stringify({
      reportStart: savedAd.reportStart,
      reportEnd: savedAd.reportEnd,
      metrics
    }))
    .digest("hex");

  // Проверяем последний снимок этого объявления
  const previous = database.history.find(
    item => item.sourceKey === savedAd.sourceKey
  );

  // Не добавляем повтор одинакового снимка
  if (previous && previous.fingerprint === fingerprint) {
    continue;
  }

  newHistory.push({
    id: crypto.randomUUID(),
    importId: report.id,

    adId: savedAd.id,
    sourceKey: savedAd.sourceKey,
    adName: savedAd.name,

    importedAt: report.importedAt,

    reportStart: savedAd.reportStart || null,
    reportEnd: savedAd.reportEnd || null,

    currency: savedAd.currency || null,

    metrics,
    fingerprint
  });
}

database.history.unshift(...newHistory);

// Ограничиваем историю, чтобы JSON не рос бесконечно
database.history = database.history.slice(0, 10000);

report.historySaved = newHistory.length;

database.imports.unshift(report);
database.imports = database.imports.slice(0, 50);



    writeDatabase(database);

    return res.json({
      success: true,
      message: "Импорт завершён",
      summary: report,
      ads: database.ads
    });

  } catch (error) {
    console.error("Meta Ads import error:", error);

    return res.status(400).json({
      success: false,
      message: error.message || "Ошибка обработки CSV"
    });
  }
});

// GET /api/meta-ads/:adId/history
// История показателей одного объявления
router.get("/:adId/history", (req, res) => {
  try {
    const database = readDatabase();

    const ad = database.ads.find(item =>
      String(item.id) === String(req.params.adId) ||
      String(item.sourceKey) === String(req.params.adId)
    );

    if (!ad) {
      return res.status(404).json({
        success: false,
        message: "Объявление не найдено"
      });
    }

    const history = database.history
      .filter(item => item.sourceKey === ad.sourceKey)
      .sort(
        (a, b) =>
          new Date(a.importedAt) - new Date(b.importedAt)
      );

    return res.json({
      success: true,

      ad: {
        id: ad.id,
        name: ad.name,
        currency: ad.currency
      },

      current: calculateMetrics(ad),
      history
    });

  } catch (error) {
    console.error("Meta Ads history error:", error);

    return res.status(500).json({
      success: false,
      message: "Ошибка получения истории объявления"
    });
  }
});

router.patch("/:adId/status", (req, res) => {
  try {
    const allowed = [
      "Новые",
      "В тесте",
      "Тест пройден",
      "Масштабирование",
      "Стоп"
    ];

    const status = String(req.body?.status || "");

    if (!allowed.includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Недопустимый этап Kanban"
      });
    }

    const database = readDatabase();

    const ad = database.ads.find(
      item => String(item.id) === String(req.params.adId)
    );

    if (!ad) {
      return res.status(404).json({
        success: false,
        message: "Объявление не найдено"
      });
    }

    ad.status = status;
    ad.statusUpdatedAt = new Date().toISOString();

    writeDatabase(database);

    return res.json({
      success: true,
      ad
    });

  } catch (error) {
    console.error("Meta Ads status error:", error);

    return res.status(500).json({
      success: false,
      message: "Не удалось сохранить статус"
    });
  }
});

router.use((error, _req, res, _next) => {
  const message =
    error.code === "LIMIT_FILE_SIZE"
      ? "Файл слишком большой. Максимум 12 МБ."
      : error.message || "Ошибка загрузки";

  res.status(400).json({
    success: false,
    message
  });
});

module.exports = router;
