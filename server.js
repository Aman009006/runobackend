const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { getCurrentBranch } = require("./branchContext");

require("dotenv").config();

const { router: authRouter, requireAuth } = require("./auth");

const app = express();

app.use(
  cors({
    origin: [
      "http://localhost:3000",
      "http://localhost:3001",
      "https://runo.kg",
    ],
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

app.use(express.json());

// ========================================
// AUTH
// ========================================

// Авторизация доступна без авторизации
app.use("/api/auth", authRouter);

// ========================================
// PROTECTED API
// ========================================

// Всё остальное API требует входа
app.use("/api", requireAuth);

const writeoffRouter = require("./writeoff.routes");
const personnelRouter = require("./personnel");

const expensesRouter = require("./expenses");
const amanatRoutes = require("./amanat");

app.use("/api/expenses", expensesRouter);
app.use("/api/moysklad", writeoffRouter);
app.use("/api", personnelRouter);

const transfersRoutes = require("./transfers");

app.use("/api/transfers", transfersRoutes);
const cashRouter = require("./cash.routes");

app.use("/api/moysklad/cash", cashRouter);
app.use("/api/moysklad", amanatRoutes);

const reportsRouter = require("./reports");

app.use("/api/reports", reportsRouter);

const PORT = process.env.PORT || 3000;

const AGENT = process.env.MOYSKLAD_AGENT;

const LOGIN = process.env.MOYSKLAD_LOGIN;
const PASSWORD = process.env.MOYSKLAD_PASSWORD;

const MOYSKLAD_API = "https://api.moysklad.ru/api/remap/1.2";

const MOYSKLAD_POS_API = "https://online.moysklad.ru/api/posap/1.0";

const reservationsRouter = require("./reservations.routes");

// =========================================================
// LOCAL SALES STORAGE
// =========================================================

const DATA_DIR = path.join(__dirname, "..", "data");
const SALES_FILE = path.join(DATA_DIR, "sales.json");
const CASH_FILE = path.join(DATA_DIR, "cash.json");
const SALESPERSONS_FILE = path.join(DATA_DIR, "personnel.json");
const RETURNS_FILE = path.join(DATA_DIR, "returns.json");

// Создаем папку data
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// =========================================================
// BRANCH LOCAL JSON STORAGE
// =========================================================

const DEFAULT_BRANCHES = ["bishkek", "dordoy", "osh"];

function getBranchKey() {
  const branch = getCurrentBranch();

  if (!branch?.id) {
    throw new Error("Текущий филиал не определён");
  }

  return String(branch.id).toLowerCase();
}

/**
 * Читает JSON-файл целиком.
 *
 * Новый формат:
 * {
 *   bishkek: ...,
 *   dordoy: ...,
 *   osh: ...
 * }
 */
function readBranchJson(filePath, defaultValue) {
  try {
    if (!fs.existsSync(filePath)) {
      return {};
    }

    const content = fs.readFileSync(filePath, "utf8");

    if (!content.trim()) {
      return {};
    }

    const data = JSON.parse(content);

    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return {};
    }

    return data;
  } catch (error) {
    console.error(`Ошибка чтения ${filePath}:`, error);

    return {};
  }
}

/**
 * Получить данные только текущего филиала.
 */
function readBranchData(filePath, defaultValue) {
  const allData = readBranchJson(filePath, defaultValue);

  const branchKey = getBranchKey();

  if (
    !Object.prototype.hasOwnProperty.call(allData, branchKey) ||
    allData[branchKey] === undefined ||
    allData[branchKey] === null
  ) {
    return defaultValue;
  }

  return allData[branchKey];
}

/**
 * Записать данные только текущего филиала,
 * сохранив остальные филиалы.
 */
function writeBranchData(filePath, value, defaultValue) {
  const allData = readBranchJson(filePath, defaultValue);

  const branchKey = getBranchKey();

  allData[branchKey] = value;

  fs.writeFileSync(
    filePath,
    JSON.stringify(allData, null, 2),
    "utf8",
  );

  return value;
}

if (!fs.existsSync(SALES_FILE)) {
  fs.writeFileSync(SALES_FILE, JSON.stringify({}, null, 2), "utf8");
}
function getDefaultCashData() {
  return {
    balance: 0,
    transactions: [],
  };
}

function readSales() {
  try {
    return readBranchData(
      SALES_FILE,
      {},
    );
  } catch (error) {
    console.error("Ошибка чтения продаж текущего филиала:", error);

    return {};
  }
}

function readSalespersons() {
  try {
    return readBranchData(
      SALESPERSONS_FILE,
      [],
    );
  } catch (error) {
    console.error(
      "Ошибка чтения продавцов текущего филиала:",
      error,
    );

    return [];
  }
}

function writeSales(sales) {
  try {
    writeBranchData(
      SALES_FILE,
      sales,
      {},
    );
  } catch (error) {
    console.error("Ошибка записи продаж текущего филиала:", error);

    throw error;
  }
}


async function sendTelegramCancellationNotification(sale) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
   const branch = getCurrentBranch();
   const branchKey = String(branch.id).toLowerCase();

    // Новый формат:
    // {
    //   bishkek: {...},
    //   dordoy: {...},
    //   osh: {...}
    // }
    const telegramChatIds = {
  bishkek: process.env.TELEGRAM_CHAT_ID_BISHKEK,
  dordoy: process.env.TELEGRAM_CHAT_ID_DORDOY,
  osh: process.env.TELEGRAM_CHAT_ID_OSH,
};

const chatId = telegramChatIds[branchKey];
  // const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!botToken || !chatId) {
    return;
  }

  const cancelledAt = sale.cancelledAt
    ? new Date(sale.cancelledAt)
    : new Date();

  const formattedDate = cancelledAt.toLocaleString("ru-RU", {
    timeZone: "Asia/Bishkek",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const totalSom = Number(sale.totalSom ?? Number(sale.total || 0) / 100);

  const formattedTotal = new Intl.NumberFormat("ru-RU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(totalSom);

  let itemsText = "";

  if (Array.isArray(sale.items) && sale.items.length > 0) {
    itemsText = sale.items
      .map((item, index) => {
        const name = item.name || item.title || item.productName || "Товар";

        const quantity = Number(item.quantity || 0);

        return `${index + 1}. ${name} — ${quantity} шт.`;
      })
      .join("\n");
  } else {
    itemsText = "Товары не указаны";
  }

  const salesperson =
    typeof sale.salesperson === "object"
      ? sale.salesperson?.name || "Не указан"
      : sale.salesperson || "Не указан";

  const message =
    `🔴 <b>ПРОДАЖА ОТМЕНЕНА</b>\n\n` +
    `🕐 <b>Время:</b> ${formattedDate}\n` +
    `🧾 <b>Продажа:</b> ${sale.id || "Не указана"}\n` +
    `👤 <b>Продавец:</b> ${salesperson}\n` +
    `💰 <b>Сумма:</b> ${formattedTotal} сом\n\n` +
    `💰 <b>Способ оплаты:</b> ${sale.payment.method || "Не указан"}\n\n` +
    `📦 <b>Товары:</b>\n` +
    `${itemsText}\n\n` +
    `❌ Продажа удалена из МойСклад.`;

  const response = await fetch(
    `https://api.telegram.org/bot${botToken}/sendMessage`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: "HTML",
      }),
    },
  );

  if (!response.ok) {
    const errorText = await response.text();

    throw new Error(`Telegram ${response.status}: ${errorText}`);
  }
}

function saveSale(sale) {
  try {
    const salesByDate = readSales();

    const date = sale.createdAt
      ? sale.createdAt.slice(0, 10)
      : new Date().toISOString().slice(0, 10);
    if (!Array.isArray(salesByDate[date])) {
      salesByDate[date] = [];
    }
    salesByDate[date].push(sale);
    writeSales(salesByDate);

    return sale;
  } catch (error) {
    console.error("Ошибка сохранения локальной продажи:", error);

    throw error;
  }
}
function readCash() {
  try {
    const content = fs.readFileSync(CASH_FILE, "utf8");

    if (!content.trim()) {
      return {
        balance: 0,
        transactions: [],
      };
    }

    const allCash = JSON.parse(content);

    const branch = getCurrentBranch();

    if (!branch?.id) {
      throw new Error("Текущий филиал не определён");
    }

    const branchKey = String(branch.id).toLowerCase();

    // Новый формат:
    // {
    //   bishkek: {...},
    //   dordoy: {...},
    //   osh: {...}
    // }
    if (
      allCash &&
      typeof allCash === "object" &&
      !Array.isArray(allCash) &&
      (
        Object.prototype.hasOwnProperty.call(allCash, "bishkek") ||
        Object.prototype.hasOwnProperty.call(allCash, "dordoy") ||
        Object.prototype.hasOwnProperty.call(allCash, "osh")
      )
    ) {
      if (!allCash[branchKey]) {
        allCash[branchKey] = {
          balance: 0,
          transactions: [],
        };

        fs.writeFileSync(
          CASH_FILE,
          JSON.stringify(allCash, null, 2),
          "utf8"
        );
      }

      return allCash[branchKey];
    }

    // Старый формат:
    // {
    //   balance: 1000,
    //   transactions: [...]
    // }
    // Автоматически переносим его в текущий филиал.
    const migrated = {
      bishkek: {
        balance: 0,
        transactions: [],
      },
      dordoy: {
        balance: 0,
        transactions: [],
      },
      osh: {
        balance: 0,
        transactions: [],
      },
    };

    if (
      allCash &&
      typeof allCash === "object" &&
      !Array.isArray(allCash) &&
      (
        typeof allCash.balance === "number" ||
        Array.isArray(allCash.transactions)
      )
    ) {
      migrated[branchKey] = {
        balance: Number(allCash.balance) || 0,
        transactions: Array.isArray(allCash.transactions)
          ? allCash.transactions
          : [],
      };
    }

    fs.writeFileSync(
      CASH_FILE,
      JSON.stringify(migrated, null, 2),
      "utf8"
    );

    return migrated[branchKey];
  } catch (error) {
    console.error("readCash Ошибка:", error);

    return {
      balance: 0,
      transactions: [],
    };
  }
}


function writeCash(cash) {
  try {
    const branch = getCurrentBranch();

    if (!branch?.id) {
      throw new Error("Текущий филиал не определён");
    }

    const branchKey = String(branch.id).toLowerCase();

    let allCash = {};

    try {
      const content = fs.readFileSync(CASH_FILE, "utf8");

      if (content.trim()) {
        allCash = JSON.parse(content);
      }
    } catch {
      allCash = {};
    }

    // Если старый формат — создаём новый
    if (
      !allCash ||
      typeof allCash !== "object" ||
      Array.isArray(allCash) ||
      (
        !Object.prototype.hasOwnProperty.call(allCash, "bishkek") &&
        !Object.prototype.hasOwnProperty.call(allCash, "dordoy") &&
        !Object.prototype.hasOwnProperty.call(allCash, "osh")
      )
    ) {
      allCash = {
        bishkek: {
          balance: 0,
          transactions: [],
        },
        dordoy: {
          balance: 0,
          transactions: [],
        },
        osh: {
          balance: 0,
          transactions: [],
        },
      };
    }

    // Записываем ТОЛЬКО текущий филиал
    allCash[branchKey] = cash;

    fs.writeFileSync(
      CASH_FILE,
      JSON.stringify(allCash, null, 2),
      "utf8"
    );
  } catch (error) {
    console.error("writeCash Ошибка:", error);
    throw error;
  }
}
// =========================================================
// ADD SALE CASH TO CASH.JSON
// =========================================================

function addSaleToCash(cashSum, salesperson, orderId = null) {
  try {
    if (!cashSum || cashSum <= 0) {
      return null;
    }

    const cashData = readCash();

    if (!Array.isArray(cashData.transactions)) {
      cashData.transactions = [];
    }

    if (typeof cashData.balance !== "number") {
      cashData.balance = 0;
    }

    const amountSom = cashSum / 100;

    const balanceBefore = cashData.balance;

    const balanceAfter = balanceBefore + amountSom;

    const transaction = {
      id: `CASH-SALE-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,

      type: "sale",

      amount: amountSom,

      balanceBefore,

      balanceAfter,

      orderId: orderId || null,

      responsible:
        typeof salesperson === "object"
          ? salesperson.name || "Не указан"
          : salesperson || "Не указан",

      comment: "Оплата розничной продажи",

      createdAt: new Date().toISOString(),
    };

    cashData.balance = balanceAfter;

    cashData.transactions.push(transaction);

    writeCash(cashData);

    return transaction;
  } catch (error) {
    console.error("Ошибка добавления продажи в cash.json:", error);

    throw error;
  }
}

// =========================================================
// ADD RETURN CASH TO CASH.JSON
// =========================================================

function addReturnToCash(
  cashSum,
  orderId,
  returnId,
  returnDocumentId,
  isCancellation = false,
) {
  try {
    if (!cashSum || cashSum <= 0) {
      return null;
    }

    const cashData = readCash();

    if (!Array.isArray(cashData.transactions)) {
      cashData.transactions = [];
    }

    if (typeof cashData.balance !== "number") {
      cashData.balance = 0;
    }

    const amountSom = cashSum / 100;

    const balanceBefore = cashData.balance;

    const balanceAfter = balanceBefore - amountSom;

    const transaction = {
      id: `${
        isCancellation ? "CASH-CANCELLATION" : "CASH-RETURN"
      }-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,

      type: isCancellation ? "cancellation" : "return",

      amount: -amountSom,

      balanceBefore,

      balanceAfter,

      orderId: orderId || null,

      returnId: returnId || null,

      returnDocumentId: returnDocumentId || null,

      comment: isCancellation
        ? "Отмена платежа"
        : "Возврат денег за товар",

      createdAt: new Date().toISOString(),
    };

    cashData.balance = balanceAfter;

    cashData.transactions.push(transaction);

    writeCash(cashData);

    return transaction;
  } catch (error) {
    console.error(
      isCancellation
        ? "Ошибка записи отмены платежа в кассу:"
        : "Ошибка записи возврата в кассу:",
      error,
    );

    throw error;
  }
}
function readReturns() {
  try {
    return readBranchData(
      RETURNS_FILE,
      [],
    );
  } catch (error) {
    console.error("Ошибка чтения returns.json:", error);

    return [];
  }
}

function writeReturns(returns) {
  try {
    writeBranchData(
      RETURNS_FILE,
      returns,
      [],
    );
  } catch (error) {
    console.error("Ошибка записи returns.json:", error);

    throw error;
  }
}

app.get("/api/moysklad/sales", (req, res) => {
  try {
    const salesByDate = readSales();

    const allSales = Object.entries(salesByDate).flatMap(([date, sales]) =>
      sales.map((sale) => ({
        ...sale,
        date,
      })),
    );

    const sortedSales = allSales.sort(
      (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
    );

    return res.json({
      success: true,

      total: sortedSales.length,

      rows: sortedSales,

      // Дополнительно возвращаем
      // группировку по датам
      byDate: salesByDate,
    });
  } catch (error) {
    console.error("Ошибка получения локальных продаж:", error);

    return res.status(500).json({
      success: false,

      message: error.message || "Не удалось загрузить историю продаж",
    });
  }
});

app.use("/api/reservations", reservationsRouter);

let moySkladToken = null;
let moySkladOrganization = null;

const posAuthCache = new Map();
// let posCashierUid = null;

/* =========================================================
   POS AUTH
========================================================= */

async function getPosAuth() {
  const branch = getCurrentBranch();

  const branchId = branch.id;
  const retailStoreId = branch.retailStoreId;

  const cached = posAuthCache.get(branchId);

  if (cached?.token && cached?.uid) {
    return {
      token: cached.token,
      uid: cached.uid,
    };
  }

  if (!LOGIN || !PASSWORD) {
    throw new Error("MOYSKLAD_LOGIN или MOYSKLAD_PASSWORD не указаны в .env");
  }

  if (!retailStoreId) {
    throw new Error(
      `MOYSKLAD_RETAIL_STORE_ID для филиала ${branch.name} не указан`,
    );
  }

  const credentials = Buffer.from(`${LOGIN}:${PASSWORD}`).toString("base64");

  const response = await fetch(
    `${MOYSKLAD_POS_API}/admin/attach/${retailStoreId}`,
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${credentials}`,
      },
    },
  );

  if (!response.ok) {
    const errorText = await response.text();

    throw new Error(
      `Ошибка получения POS token для филиала ${branch.name}: ${response.status} ${errorText}`,
    );
  }

  const data = await response.json();

  if (!data.token) {
    throw new Error(`МойСклад не вернул POS token для филиала ${branch.name}`);
  }

  if (!data.uid) {
    throw new Error(
      `МойСклад не вернул UID кассира для филиала ${branch.name}`,
    );
  }

  posAuthCache.set(branchId, {
    token: data.token,
    uid: data.uid,
  });

  return {
    token: data.token,
    uid: data.uid,
  };
}

/* =========================================================
   OPEN RETAIL SHIFT
========================================================= */

async function openRetailShift() {
  const { token, uid } = await getPosAuth();

  const branch = getCurrentBranch();
  const retailStoreId = branch.retailStoreId;
  const retailShiftSyncId = crypto.randomUUID();

  const shiftName = `POS-${Date.now()}`;

  const openMoment = new Date().toISOString().slice(0, 19).replace("T", " ");

  const response = await fetch(`${MOYSKLAD_POS_API}/rpc/openshift/`, {
    method: "PUT",

    headers: {
      "Content-Type": "application/json",

      "Lognex-Pos-Auth-Token": token,

      "Lognex-Pos-Auth-Cashier-Uid": uid,
    },

    body: JSON.stringify({
      retailShift: {
        meta: {
          href: `${MOYSKLAD_POS_API}/entity/retailshift/syncid/${retailShiftSyncId}`,
        },
      },

      name: shiftName,

      openmoment: openMoment,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();

    if (response.status === 401 || response.status === 403) {
      posAuthCache.delete(branch.id);
    }

    throw new Error(
      `Ошибка открытия смены МойСклад: ${response.status} ${errorText}`,
    );
  }

  return {
    success: true,

    retailShiftSyncId,

    shiftName,

    openMoment,

    retailStoreId,
  };
}

async function closeRetailShift(retailShiftSyncId) {
  if (!retailShiftSyncId) {
    throw new Error("Не указан retailShiftSyncId");
  }
  const branch = getCurrentBranch();
  const retailStoreId = branch.retailStoreId;

  const { token, uid } = await getPosAuth();

  const closeMoment = new Date().toISOString().slice(0, 19).replace("T", " ");

  const response = await fetch(`${MOYSKLAD_POS_API}/rpc/closeshift/`, {
    method: "PUT",

    headers: {
      "Content-Type": "application/json",

      "Lognex-Pos-Auth-Token": token,

      "Lognex-Pos-Auth-Cashier-Uid": uid,
    },

    body: JSON.stringify({
      retailShift: {
        meta: {
          href: `${MOYSKLAD_POS_API}/entity/retailshift/syncid/${retailShiftSyncId}`,
        },
      },

      closemoment: closeMoment,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();

    if (response.status === 401 || response.status === 403) {
      posAuthCache.delete(branch.id);
    }

    throw new Error(
      `Ошибка закрытия смены МойСклад: ${response.status} ${errorText}`,
    );
  }

  return {
    success: true,

    retailShiftSyncId,

    closeMoment,

    retailStoreId,
  };
}

async function authorizeMoySklad() {
  if (!LOGIN || !PASSWORD) {
    throw new Error("MOYSKLAD_LOGIN или MOYSKLAD_PASSWORD не указаны в .env");
  }

  const credentials = Buffer.from(`${LOGIN}:${PASSWORD}`).toString("base64");

  const response = await fetch(`${MOYSKLAD_API}/security/token`, {
    method: "POST",

    headers: {
      Authorization: `Basic ${credentials}`,

      Accept: "application/json;charset=utf-8",
    },
  });

  if (!response.ok) {
    const errorText = await response.text();

    throw new Error(
      `Ошибка авторизации МойСклад: ${response.status} ${errorText}`,
    );
  }

  const data = await response.json();

  moySkladToken = data.access_token;

  return moySkladToken;
}

/* =========================================================
   GENERIC MOYSKLAD REQUEST
========================================================= */

async function moySkladRequest(path, options = {}) {
  if (!moySkladToken) {
    await authorizeMoySklad();
  }

  let response = await fetch(`${MOYSKLAD_API}${path}`, {
    ...options,

    headers: {
      Accept: "application/json;charset=utf-8",

      Authorization: `Bearer ${moySkladToken}`,

      ...(options.headers || {}),
    },
  });

  if (response.status === 401) {
    moySkladToken = null;

    await authorizeMoySklad();

    response = await fetch(`${MOYSKLAD_API}${path}`, {
      ...options,

      headers: {
        Accept: "application/json;charset=utf-8",

        Authorization: `Bearer ${moySkladToken}`,

        ...(options.headers || {}),
      },
    });
  }

  if (!response.ok) {
    const errorText = await response.text();

    throw new Error(`МойСклад ${response.status}: ${errorText}`);
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

async function deleteMoySkladRetailDemand(id) {
  if (!moySkladToken) {
    await authorizeMoySklad();
  }

  let response = await fetch(`${MOYSKLAD_API}/entity/retaildemand/${id}`, {
    method: "DELETE",
    headers: {
      Accept: "application/json;charset=utf-8",
      Authorization: `Bearer ${moySkladToken}`,
    },
  });

  // Если токен устарел — получаем новый и повторяем DELETE
  if (response.status === 401) {
    moySkladToken = null;

    await authorizeMoySklad();

    response = await fetch(`${MOYSKLAD_API}/entity/retaildemand/${id}`, {
      method: "DELETE",
      headers: {
        Accept: "application/json;charset=utf-8",
        Authorization: `Bearer ${moySkladToken}`,
      },
    });
  }

  if (!response.ok) {
    const errorText = await response.text();

    throw new Error(`МойСклад ${response.status}: ${errorText}`);
  }

  // DELETE может вернуть пустой ответ — это нормально
  return true;
}

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,

    message: "Backend работает",
  });
});

app.post("/api/moysklad/retail-shift/open", async (req, res) => {
  try {
    const result = await openRetailShift();

    return res.status(200).json(result);
  } catch (error) {
    console.error("Ошибка открытия смены:", error);

    return res.status(500).json({
      success: false,

      message: error.message || "Не удалось открыть смену",
    });
  }
});

/* =========================================================
   CLOSE SHIFT
========================================================= */

app.post("/api/moysklad/retail-shift/close", async (req, res) => {
  try {
    const { retailShiftSyncId } = req.body;

    if (!retailShiftSyncId) {
      return res.status(400).json({
        success: false,

        message: "Не указан retailShiftSyncId",
      });
    }

    const result = await closeRetailShift(retailShiftSyncId);

    return res.status(200).json(result);
  } catch (error) {
    console.error("Ошибка закрытия смены:", error);

    return res.status(500).json({
      success: false,

      message: error.message || "Не удалось закрыть смену",
    });
  }
});

/* =========================================================
   STORES
========================================================= */

app.get("/api/moysklad/stores", async (req, res) => {
  try {
    const data = await moySkladRequest("/entity/store?limit=100");

    const stores = (data.rows || []).map((store) => ({
      id: store.id,

      name: store.name || "Склад без названия",

      pathName: store.pathName || "",

      address: store.address || "",
    }));

    return res.json({
      rows: stores,
    });
  } catch (error) {
    console.error("Ошибка получения складов:", error);

    return res.status(500).json({
      message: error.message || "Ошибка получения складов",
    });
  }
});

/* =========================================================
   SINGLE STORE
========================================================= */

app.get("/api/moysklad/stores/:storeId", async (req, res) => {
  try {
    const { storeId } = req.params;

    const data = await moySkladRequest(`/entity/store/${storeId}`);

    return res.json(data);
  } catch (error) {
    console.error("Ошибка получения склада:", error);

    return res.status(500).json({
      message: error.message || "Ошибка получения склада",
    });
  }
});

/* =========================================================
   RETAIL STORES
========================================================= */

app.get("/api/moysklad/retail-stores", async (req, res) => {
  try {
    const data = await moySkladRequest("/entity/retailstore?limit=100");

    const retailStores = (data.rows || []).map((retailStore) => ({
      id: retailStore.id,

      name: retailStore.name || "Розничная точка без названия",

      address: retailStore.address || "",

      active: retailStore.active,

      meta: retailStore.meta || null,
    }));

    return res.json({
      total: retailStores.length,

      rows: retailStores,
    });
  } catch (error) {
    console.error("Ошибка получения retailstore:", error);

    return res.status(500).json({
      message: error.message || "Не удалось получить розничные точки",
    });
  }
});

async function calculateBundleStock(bundle, stockRows) {
  try {
    const bundleId = bundle.id;

    if (!bundleId) {
      return 0;
    }

    const components = await getBundleComponents(bundleId);

    if (components.length === 0) {
      return 0;
    }

    let possibleBundles = Infinity;

    for (const component of components) {
      const componentQuantity = Number(component.quantity || 0);

      if (!Number.isFinite(componentQuantity) || componentQuantity <= 0) {
        continue;
      }

      const componentMeta = component.assortment?.meta;

      if (!componentMeta?.href) {
        console.warn(
          `У компонента комплекта "${bundle.name}" нет assortment.meta`,
          component,
        );

        return 0;
      }

      const componentHref = componentMeta.href.split("?")[0];

      const componentId = componentHref.split("/").pop();

      const stockItem = stockRows.find((item) => {
        const href = item.meta?.href?.split("?")[0];

        const id = href?.split("/").pop();

        return (
          id === componentId &&
          (item.meta?.type === componentMeta.type || !componentMeta.type)
        );
      });

      const stock = Number(stockItem?.stock || 0);

      /*
       * Сколько комплектов можно собрать
       * из этого компонента
       */

      const componentBundles = Math.floor(stock / componentQuantity);

      possibleBundles = Math.min(possibleBundles, componentBundles);

      /*
       * Если хотя бы одного компонента нет —
       * комплектов тоже нет.
       */

      if (possibleBundles <= 0) {
        return 0;
      }
    }

    if (!Number.isFinite(possibleBundles)) {
      return 0;
    }

    return possibleBundles;
  } catch (error) {
    console.error(`Ошибка расчёта остатка комплекта "${bundle.name}":`, error);

    return 0;
  }
}

const bundleComponentsCache = new Map();

const BUNDLE_CACHE_TTL = 5 * 60 * 1000; // 5 минут

// =========================================================
// PRODUCTS CACHE
// =========================================================

const productsCache = new Map();

const PRODUCTS_CACHE_TTL = 5 * 60 * 1000;

// Чтобы несколько запросов одновременно
// не запускали несколько одинаковых загрузок
const productsLoading = new Map();

async function getBundleComponents(bundleId) {
  const cached = bundleComponentsCache.get(bundleId);

  if (cached && Date.now() - cached.timestamp < BUNDLE_CACHE_TTL) {
    return cached.components;
  }

  const data = await moySkladRequest(
    `/entity/bundle/${bundleId}/components?limit=100&expand=assortment`,
  );

  const components = data?.rows || [];

  bundleComponentsCache.set(bundleId, {
    timestamp: Date.now(),
    components,
  });

  return components;
}

async function getAllMoySkladRows(path, pageSize = 1000) {
  const allRows = [];
  let offset = 0;

  while (true) {
    const separator = path.includes("?") ? "&" : "?";

    const requestPath = `${path}${separator}limit=${pageSize}&offset=${offset}`;

    const data = await moySkladRequest(
      `${path}${separator}limit=${pageSize}&offset=${offset}`,
    );

    const rows = data?.rows || [];

    allRows.push(...rows);

    if (rows.length < pageSize) {
      break;
    }

    offset += pageSize;
  }

  return allRows;
}
async function refreshProductsCache(storeId) {
  if (productsLoading.has(storeId)) {
    return productsLoading.get(storeId);
  }

  const loadingPromise = (async () => {
    try {
      const storeHref = `${MOYSKLAD_API}/entity/store/${storeId}`;

      const filterParam = encodeURIComponent(`store=${storeHref}`);

      const stockRows = await getAllMoySkladRows(
        `/report/stock/all?filter=${filterParam}`,
      );

      const productRows = await getAllMoySkladRows(`/entity/product`);

      const variantRows = await getAllMoySkladRows(`/entity/variant`);

      const bundles = await getAllMoySkladRows(`/entity/bundle`);

      const stockMap = new Map();

      for (const item of stockRows) {
        const rawHref = item.meta?.href || "";

        const cleanHref = rawHref.split("?")[0];

        const id = cleanHref.split("/").pop() || "";

        if (!id) {
          continue;
        }

        const type = item.meta?.type || "product";

        stockMap.set(`${type}:${id}`, item);
      }

      /*
       * =================================================
       * 6. ФУНКЦИЯ ПОЛУЧЕНИЯ ЦЕНЫ
       * =================================================
       */

      function getSalePrice(item, stockItem) {
        /*
         * Для stock report
         */

        if (stockItem?.salePrice != null) {
          return Number(stockItem.salePrice) / 100;
        }

        /*
         * Для product / variant
         */

        if (item.salePrices?.[0]?.value != null) {
          return Number(item.salePrices[0].value) / 100;
        }

        if (item.salePrice?.value != null) {
          return Number(item.salePrice.value) / 100;
        }

        return 0;
      }

      /*
       * =================================================
       * 7. ФУНКЦИЯ ПОЛУЧЕНИЯ ЦЕНЫ ЗАКУПКИ
       * =================================================
       */

      function getBuyPrice(item, stockItem) {
        /*
         * В stock report цена закупки
         */

        if (stockItem?.price != null) {
          return Number(stockItem.price) / 100;
        }

        /*
         * В product / variant buyPrice
         * может быть числом
         */

        if (typeof item.buyPrice === "number") {
          return Number(item.buyPrice) / 100;
        }

        /*
         * Или объектом { value: ... }
         */

        if (item.buyPrice?.value != null) {
          return Number(item.buyPrice.value) / 100;
        }

        return 0;
      }

      /*
       * =================================================
       * 8. ФУНКЦИЯ ПОЛУЧЕНИЯ ID
       * =================================================
       */

      function getEntityId(item) {
        const rawHref = item.meta?.href || "";

        const cleanHref = rawHref.split("?")[0];

        return cleanHref.split("/").pop() || item.id || "";
      }

      /*
       * =================================================
       * 9. ПРЕОБРАЗОВАНИЕ PRODUCT / VARIANT
       * =================================================
       */

      function normalizeCatalogItem(item, type) {
        const id = getEntityId(item);

        const stockItem = stockMap.get(`${type}:${id}`);

        const price = getSalePrice(item, stockItem);

        const buyPrice = getBuyPrice(item, stockItem);

        /*
         * Если позиции нет в stock report,
         * она всё равно должна существовать.
         *
         * Просто остаток будет 0.
         */

        const stock = stockItem ? Number(stockItem.stock || 0) : 0;

        const reserve = stockItem ? Number(stockItem.reserve || 0) : 0;

        const inTransit = stockItem ? Number(stockItem.inTransit || 0) : 0;

        const reserveStock = stockItem
          ? Number(stockItem.reserveStock || 0)
          : 0;

        return {
          id,

          name:
            item.name ||
            (type === "variant"
              ? "Модификация без названия"
              : "Товар без названия"),

          code: item.code || "",

          article: item.article || "",

          price,

          buyPrice,

          costPrice: buyPrice,

          stock,

          reserve,

          inTransit,

          reserveStock,

          meta: item.meta,

          uom: item.uom?.name || stockItem?.uom?.name || "шт",

          pathName:
            item.productFolder?.name ||
            item.folder?.name ||
            stockItem?.folder?.name ||
            stockItem?.productFolder?.name ||
            "Общая категория",

          description: item.description || "",

          type,

          isBundle: false,

          /*
           * Дополнительно сохраняем,
           * что это именно модификация.
           */

          isVariant: type === "variant",
        };
      }

      /*
       * =================================================
       * 10. ОБЫЧНЫЕ ТОВАРЫ
       * =================================================
       */

      const products = productRows.map((item) =>
        normalizeCatalogItem(item, "product"),
      );

      /*
       * =================================================
       * 11. МОДИФИКАЦИИ
       * =================================================
       */

      const variants = variantRows.map((item) =>
        normalizeCatalogItem(item, "variant"),
      );

      /*
       * =================================================
       * 12. КОМПЛЕКТЫ
       * =================================================
       */

      const bundleProducts = [];

      for (const bundle of bundles) {
        try {
          const bundleId = getEntityId(bundle);

          const price =
            bundle.salePrices?.[0]?.value != null
              ? Number(bundle.salePrices[0].value) / 100
              : 0;

          const buyPrice =
            bundle.buyPrice?.value != null
              ? Number(bundle.buyPrice.value) / 100
              : typeof bundle.buyPrice === "number"
                ? Number(bundle.buyPrice) / 100
                : 0;

          const stock = await calculateBundleStock(bundle, stockRows);

          bundleProducts.push({
            id: bundleId,

            name: bundle.name || "Комплект без названия",

            code: bundle.code || "",

            article: bundle.article || "",

            price,

            buyPrice,

            costPrice: buyPrice,

            stock,

            reserve: 0,

            inTransit: 0,

            reserveStock: 0,

            meta: bundle.meta,

            uom: bundle.uom?.name || "шт",

            pathName:
              bundle.productFolder?.name ||
              bundle.folder?.name ||
              "Общая категория",

            description: bundle.description || "",

            type: "bundle",

            isBundle: true,

            isVariant: false,
          });
        } catch (error) {
          console.error(
            `Ошибка обработки комплекта "${bundle.name}":`,
            error.message,
          );
        }
      }

      /*
       * =================================================
       * 13. ОБЪЕДИНЯЕМ ВСЁ
       * =================================================
       */

      const allProducts = [...products, ...variants, ...bundleProducts];

      /*
       * =================================================
       * 14. ПРОВЕРКА
       * =================================================
       */

      if (allProducts.length === 0) {
        throw new Error("МойСклад вернул пустой список товаров");
      }

      /*
       * =================================================
       * 15. РЕЗУЛЬТАТ
       * =================================================
       */

      const result = {
        storeId,

        // storeName: "Молодая Гвардия 41",

        total: allProducts.length,

        productsCount: products.length,

        variantsCount: variants.length,

        bundlesCount: bundleProducts.length,

        rows: allProducts,
      };

      /*
       * =================================================
       * 16. СОХРАНЯЕМ В КЭШ
       * =================================================
       */

      productsCache.set(storeId, {
        timestamp: Date.now(),

        data: result,
      });

      return result;
    } catch (error) {
      console.error("Ошибка обновления products:", error.message);

      throw error;
    } finally {
      productsLoading.delete(storeId);
    }
  })();

  productsLoading.set(storeId, loadingPromise);

  return loadingPromise;
}

async function forceRefreshProductsCache(storeId) {
  if (!storeId) {
    throw new Error("Не указан storeId");
  }

  const data = await refreshProductsCache(storeId);

  return {
    success: true,
    data,
    cached: false,
    cacheAge: 0,
  };
}

app.get("/api/moysklad/products", async (req, res) => {
  const branch = getCurrentBranch();

  const storeId = branch.storeId;

  const cached = productsCache.get(storeId);

  /*
   * =====================================================
   * ЕСЛИ ЕСТЬ КЭШ
   * =====================================================
   */

  if (cached) {
    const cacheAge = Date.now() - cached.timestamp;

    res.json({
      ...cached.data,

      cached: true,

      cacheAge,
    });

    /*
     * Если кэш свежий —
     * обновление вообще не нужно.
     */

    if (cacheAge < PRODUCTS_CACHE_TTL) {
      return;
    }

    /*
     * Кэш устарел.
     *
     * Ответ уже отправили.
     * Теперь обновляем в фоне.
     */

    refreshProductsCache(storeId).catch((error) => {
      console.error(
        `Ошибка фонового обновления товаров ${storeId}:`,
        error.message,
      );
    });

    return;
  }

  /*
   * =====================================================
   * КЭША НЕТ
   * =====================================================
   */

  try {
    const data = await refreshProductsCache(storeId);

    return res.json({
      ...data,

      cached: false,

      cacheAge: 0,
    });
  } catch (error) {
    console.error("Ошибка первого получения товаров:", error);

    return res.status(500).json({
      success: false,

      message: error.message || "Ошибка получения товаров МойСклад",
    });
  }
});

app.post("/api/moysklad/products/refresh", async (req, res) => {
  const branch = getCurrentBranch();
  const storeId = branch.storeId;

  try {
    const result = await forceRefreshProductsCache(storeId);

    return res.json(result);
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || "Ошибка принудительного обновления товаров",
    });
  }
});

/* =========================================================
   GET ORGANIZATION
========================================================= */

async function getMoySkladOrganization() {
  if (moySkladOrganization) {
    return moySkladOrganization;
  }

  const data = await moySkladRequest("/entity/organization?limit=1");

  const organization = data.rows?.[0];

  if (!organization) {
    throw new Error("В МойСклад не найдена организация");
  }

  moySkladOrganization = organization;
  return organization;
}

/* =========================================================
   GET COUNTERPARTIES
========================================================= */

app.get("/api/moysklad/counterparties", async (req, res) => {
  try {
    const data = await moySkladRequest("/entity/counterparty?limit=1000");

    const counterparties = (data.rows || []).map((counterparty) => ({
      id: counterparty.id,

      name: counterparty.name || "Контрагент без названия",

      companyType: counterparty.companyType || null,

      phone: counterparty.phone || "",

      email: counterparty.email || "",

      actualAddress: counterparty.actualAddress || "",

      meta: counterparty.meta || null,
    }));

    return res.json({
      total: counterparties.length,

      rows: counterparties,
    });
  } catch (error) {
    console.error("Ошибка получения контрагентов:", error);

    return res.status(500).json({
      message: error.message || "Ошибка получения контрагентов МойСклад",
    });
  }
});

/* =========================================================
   PAYMENT VALIDATION
========================================================= */

function validatePayment(payment, total) {
  if (!payment) {
    throw new Error("Не указана информация об оплате");
  }

  const cash = Number(payment.cash || 0);
  const card = Number(payment.card || 0);
  const amanat = Number(payment.amanat || 0);
  const mplus = Number(payment.mplus || 0);
  const online_qr = Number(payment.online_qr || 0);

  const values = [cash, card, amanat, mplus, online_qr];

  if (values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error("Суммы оплаты должны быть положительными числами");
  }

  const paymentTotal = cash + card + amanat + mplus + online_qr;

  if (Math.round(paymentTotal) !== Math.round(total)) {
    throw new Error(
      `Сумма оплаты (${paymentTotal}) не равна сумме заказа (${total})`,
    );
  }

  return {
    cash,
    card,
    amanat,
    mplus,
    online_qr,

    paymentTotal,
  };
}

/* =========================================================
   CREATE RETAIL SALE
========================================================= */

app.post("/api/moysklad/sales", async (req, res) => {
  try {
    const {
      orderId,
      items,
      total,
      payment,
      salespersonId,
      salesperson,
      retailShiftSyncId,
    } = req.body;

    const branch = getCurrentBranch();

    const storeId = branch.storeId;
    const retailStoreId = branch.retailStoreId;
    /* -----------------------------------------
         ПРОВЕРКА КОРЗИНЫ
      ----------------------------------------- */

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        message: "Корзина пуста",
      });
    }

    /* -----------------------------------------
         ПРОВЕРКА СМЕНЫ
      ----------------------------------------- */

    if (!retailShiftSyncId) {
      return res.status(400).json({
        message: "Открытая кассовая смена не найдена",
      });
    }

    /* -----------------------------------------
         ПРОВЕРКА СУММЫ
      ----------------------------------------- */

    if (!Number.isFinite(Number(total)) || Number(total) <= 0) {
      return res.status(400).json({
        message: "Некорректная сумма заказа",
      });
    }

    const normalizedTotal = Math.round(Number(total));

    /* -----------------------------------------
         ПРОВЕРКА ОПЛАТЫ
      ----------------------------------------- */

    const normalizedPayment = validatePayment(payment, normalizedTotal);

    /* -----------------------------------------
         RETAIL STORE
      ----------------------------------------- */

    // const retailStoreId = branch.retailStoreId;

    if (!retailStoreId) {
      throw new Error("MOYSKLAD_RETAIL_STORE_ID не указан в .env");
    }

    /* -----------------------------------------
         ORGANIZATION
      ----------------------------------------- */

    const organization = await getMoySkladOrganization();

    /* -----------------------------------------
         AGENT
      ----------------------------------------- */

    if (!AGENT) {
      throw new Error("MOYSKLAD_AGENT не указан в .env");
    }

    /* -----------------------------------------
         ПОЗИЦИИ
      ----------------------------------------- */

    const positions = items.map((item) => {
      if (!item.id) {
        throw new Error(`У товара "${item.name}" отсутствует ID МойСклад`);
      }

      const quantity = Number(item.quantity);

      if (!Number.isFinite(quantity) || quantity <= 0) {
        throw new Error(`Некорректное количество товара "${item.name}"`);
      }

      const type = item.type || "product";

      const price = Math.round(Number(item.price) * 100);

      if (!Number.isFinite(price) || price < 0) {
        throw new Error(`Некорректная цена товара "${item.name}"`);
      }

      return {
        quantity,

        price,

        assortment: {
          meta: {
            href: `${MOYSKLAD_API}/entity/${type}/${item.id}`,

            type,

            mediaType: "application/json",
          },
        },
      };
    });

    /* -----------------------------------------
         ОПЛАТА
      ----------------------------------------- */

    const cashSum = normalizedPayment.cash;

    const noCashSum =
      normalizedPayment.card +
      normalizedPayment.amanat +
      normalizedPayment.mplus +
      normalizedPayment.online_qr;

    /* -----------------------------------------
         ТЕКСТ ОПЛАТЫ
      ----------------------------------------- */

    const paymentComment = [
      `POS: ${orderId}`,
      `Продавец: ${salesperson || "Не указан"}`,
      `Способ оплаты: ${payment?.method || "unknown"}`,

      `Наличные: ${(normalizedPayment.cash / 100).toFixed(2)} сом`,

      `Карта: ${(normalizedPayment.card / 100).toFixed(2)} сом`,

      `Аманат: ${(normalizedPayment.amanat / 100).toFixed(2)} сом`,

      `М+: ${(normalizedPayment.mplus / 100).toFixed(2)} сом`,

      `Онлайн QR: ${(normalizedPayment.online_qr / 100).toFixed(2)} сом`,

      `Итого: ${(normalizedTotal / 100).toFixed(2)} сом`,
    ].join("\n");

    const shiftFilter = encodeURIComponent(`syncId=${retailShiftSyncId}`);

    const shiftData = await moySkladRequest(
      `/entity/retailshift?filter=${shiftFilter}&limit=1`,
    );

    const retailShift = shiftData.rows?.[0];

    if (!retailShift) {
      throw new Error(
        `Розничная смена с syncId ${retailShiftSyncId} не найдена`,
      );
    }

    const retailDemandData = {
      name: orderId,

      description: paymentComment,

      organization: {
        meta: {
          href: organization.meta.href,

          type: "organization",

          mediaType: "application/json",
        },
      },

      agent: {
        meta: {
          href: `${MOYSKLAD_API}/entity/counterparty/${AGENT}`,

          type: "counterparty",

          mediaType: "application/json",
        },
      },

      retailStore: {
        meta: {
          href: `${MOYSKLAD_API}/entity/retailstore/${retailStoreId}`,

          type: "retailstore",

          mediaType: "application/json",
        },
      },

      retailShift: {
        meta: {
          href: `${MOYSKLAD_API}/entity/retailshift/${retailShift.id}`,

          type: "retailshift",

          mediaType: "application/json",
        },
      },

      positions,
    };

    /* -----------------------------------------
         CASH SUM
      ----------------------------------------- */

    if (cashSum > 0) {
      retailDemandData.cashSum = cashSum;
    }

    /* -----------------------------------------
         NO CASH SUM
      ----------------------------------------- */

    if (noCashSum > 0) {
      retailDemandData.noCashSum = noCashSum;
    }

    /* -----------------------------------------
         СОЗДАЁМ РОЗНИЧНУЮ ПРОДАЖУ
      ----------------------------------------- */

    const retailDemand = await moySkladRequest("/entity/retaildemand", {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
      },

      body: JSON.stringify(retailDemandData),
    });

    // =========================================================
    // СОХРАНЕНИЕ ПРОДАЖИ ЛОКАЛЬНО
    // =========================================================

    const localSaleId = `SALE-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;

    const localSale = {
      // Локальная информация
      id: localSaleId,
      orderId: orderId || null,
      salesperson: {
        id: salesperson || null,
        name: salesperson?.name || null,
      },
      // Информация о документе МойСклад
      moyskladId: retailDemand.id || null,
      moyskladHref: retailDemand.meta?.href || null,
      moyskladName: retailDemand.name || orderId || null,

      // Суммы
      totalKopecks: normalizedTotal,
      totalSom: normalizedTotal / 100,

      // Все товары в исходном формате POS
      items: items.map((item) => ({
        id: item.id || null,
        name: item.name || "",
        article: item.article || "",
        code: item.code || "",
        barcode: item.barcode || "",

        type: item.type || "product",

        quantity: Number(item.quantity),
        priceSom: Number(item.price || 0),

        priceKopecks: Math.round(Number(item.price || 0) * 100),

        totalSom: Number(item.price || 0) * Number(item.quantity),

        totalKopecks: Math.round(
          Number(item.price || 0) * Number(item.quantity) * 100,
        ),

        assortmentMeta: item.assortmentMeta || null,
      })),

      // Информация об оплате
      payment: {
        method: payment?.method || null,

        cash: normalizedPayment.cash,
        card: normalizedPayment.card,
        amanat: normalizedPayment.amanat,
        mplus: normalizedPayment.mplus,
        online_qr: normalizedPayment.online_qr,

        cashSom: normalizedPayment.cash / 100,
        cardSom: normalizedPayment.card / 100,
        amanatSom: normalizedPayment.amanat / 100,
        mplusSom: normalizedPayment.mplus / 100,
        online_qrSom: normalizedPayment.online_qr / 100,

        paymentTotal: normalizedPayment.paymentTotal,
      },

      // Суммы, отправленные в документ МойСклад
      moyskladPayment: {
        cashSum: cashSum,
        noCashSum: noCashSum,

        card: normalizedPayment.card,
        amanat: normalizedPayment.amanat,
        mplus: normalizedPayment.mplus,
        online_qr: normalizedPayment.online_qr,
      },

      // Касса и смена
      // retailStoreId: retailStoreId,
      // retailShiftSyncId: retailShiftSyncId,
      // retailShiftId: retailShift.id,
      retailStoreId,
      retailShiftSyncId,

      // Склад
      storeId: storeId || null,

      // Организация
      // organization: {
      //   id: organization.id || null,
      //   name: organization.name || null,
      //   meta: organization.meta || null,
      // },

      // Контрагент
      // agent: {
      //   id: AGENT || null,
      // },

      // Время
      createdAt: new Date().toISOString(),

      // // Полный документ, который отправили в МойСклад
      // moyskladRequest: retailDemandData,

      // // Полный ответ МойСклад
      // moyskladResponse: retailDemand,
    };

    try {
      saveSale(localSale);

      // =========================================================
      // ДОБАВЛЯЕМ НАЛИЧНУЮ ОПЛАТУ В CASH.JSON
      // =========================================================

      const cashTransaction = addSaleToCash(
        localSale.moyskladPayment.cashSum,
        salesperson,
        localSale.orderId,
      );
    } catch (localSaveError) {
      console.error("Ошибка локального сохранения продажи:", localSaveError);

      // Продажа уже создана в МойСклад,
      // поэтому не возвращаем ошибку создания продажи.
      return res.status(201).json({
        success: true,
        localSaved: false,
        warning: "Продажа создана в МойСклад, но не сохранена локально",
        orderId,
        demandId: retailDemand.id,
        payment: normalizedPayment,
        retailStoreId,
        retailShiftSyncId,
        retailShiftId: retailShift.id,
        retailDemand,
      });
    }

    return res.status(201).json({
      success: true,

      localSaved: true,
      localSaleId: localSale.id,

      orderId,

      demandId: retailDemand.id,

      payment: normalizedPayment,

      retailStoreId,

      retailShiftSyncId,

      retailShiftId: retailShift.id,

      retailDemand,
    });
  } catch (error) {
    console.error("Ошибка создания розничной продажи:", error);

    return res.status(500).json({
      success: false,

      message: error.message || "Ошибка создания розничной продажи",
    });
  }
});

// =========================================================
// ОТМЕНА РОЗНИЧНОЙ ПРОДАЖИ
// =========================================================
//
// 1. Находим локальную продажу по localSaleId
// 2. Проверяем, не отменена ли она уже
// 3. Удаляем retaildemand из МойСклад
// 4. Если МойСклад успешно удалил документ,
//    ставим cancelled: true в локальной истории
//
// Локальная продажа НЕ удаляется.
// Она остаётся в истории как отменённая.
// =========================================================

// ============================================================
// ОТМЕНА ПРОДАЖИ
// ============================================================

app.patch("/api/moysklad/sales/:saleId/cancel", async (req, res) => {
  try {
    const { saleId } = req.params;

    // ---------------------------------------------------------
    // 1. Читаем существующие продажи
    // ---------------------------------------------------------

    const salesByDate = readSales();

    let foundSale = null;
    let foundDate = null;
    let foundIndex = -1;

    // Ищем продажу во всех датах
    for (const [date, sales] of Object.entries(salesByDate)) {
      if (!Array.isArray(sales)) {
        continue;
      }

      const index = sales.findIndex(
        (sale) => String(sale.id) === String(saleId),
      );

      if (index !== -1) {
        foundSale = sales[index];
        foundDate = date;
        foundIndex = index;
        break;
      }
    }

    // ---------------------------------------------------------
    // 2. Если продажа не найдена
    // ---------------------------------------------------------

    if (!foundSale) {
      return res.status(404).json({
        success: false,
        error: "Продажа не найдена",
      });
    }

    // ---------------------------------------------------------
    // 3. Проверяем, не отменена ли уже продажа
    // ---------------------------------------------------------

    if (foundSale.cancelled === true) {
      return res.status(400).json({
        success: false,
        error: "Продажа уже отменена",
        sale: foundSale,
      });
    }

    // ---------------------------------------------------------
    // 4. Проверяем MoySklad ID
    // ---------------------------------------------------------

    if (!foundSale.moyskladId) {
      return res.status(400).json({
        success: false,
        error: "У продажи отсутствует moyskladId",
      });
    }
    // ---------------------------------------------------------
    // 5. УДАЛЯЕМ RETAILDEMAND ИЗ МОЙСКЛАДА
    // ---------------------------------------------------------

    await deleteMoySkladRetailDemand(foundSale.moyskladId);

    // ---------------------------------------------------------
    // 6. ОПРЕДЕЛЯЕМ НАЛИЧНУЮ ЧАСТЬ ПРОДАЖИ
    // ---------------------------------------------------------

    const payment =
      foundSale.payment && typeof foundSale.payment === "object"
        ? foundSale.payment
        : {};

    const cashSum = Number(payment.cash || 0);

    // ---------------------------------------------------------
    // 7. ЕСЛИ БЫЛА НАЛИЧКА — ВОЗВРАЩАЕМ ЕЁ В CASH
    // ---------------------------------------------------------

    if (cashSum > 0) {
      addReturnToCash(
        cashSum,
        foundSale.orderId || foundSale.id,
        `CANCEL-${foundSale.id}`,
        foundSale.moyskladId,
        true,
      );

      console.log(
        "Наличная часть отменённой продажи вычтена из кассы:",
        cashSum / 100,
        "сом",
      );
    } else {
      console.log("Наличной оплаты нет — cash.json не изменяем");
    }

    // ---------------------------------------------------------
    // 8. Помечаем продажу отменённой
    // ---------------------------------------------------------

    const cancelledSale = {
      ...foundSale,

      cancelled: true,

      cancelledAt: new Date().toISOString(),

      cancellationReason: req.body?.reason || "Продажа отменена кассиром",
    };

    // ---------------------------------------------------------
    // 9. Обновляем продажу в существующем массиве
    // ---------------------------------------------------------

    salesByDate[foundDate][foundIndex] = cancelledSale;

    // ---------------------------------------------------------
    // 10. Сохраняем через ТВОЙ writeSales()
    // ---------------------------------------------------------

    writeSales(salesByDate);

    // ---------------------------------------------------------
    // 11. Отправляем уведомление в Telegram
    // ---------------------------------------------------------

    try {
      await sendTelegramCancellationNotification(cancelledSale);
    } catch (telegramError) {
      console.error(
        "Не удалось отправить уведомление в Telegram:",
        telegramError,
      );
    }

    // ---------------------------------------------------------
    // 12. Отправляем результат фронту
    // ---------------------------------------------------------

    return res.json({
      success: true,
      message: "Продажа успешно отменена",
      sale: cancelledSale,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error?.message || "Не удалось отменить продажу",
    });
  }
});

// =========================================================
// UPDATE SALESPERSON IN LOCAL SALE
// =========================================================

app.patch("/api/moysklad/sales/:saleId/salesperson", (req, res) => {
  try {
    const { saleId } = req.params;
    const { salespersonId } = req.body;

    if (!saleId) {
      return res.status(400).json({
        success: false,
        message: "Не указан ID продажи",
      });
    }

    if (!salespersonId) {
      return res.status(400).json({
        success: false,
        message: "Не указан продавец",
      });
    }

    const salespersons = readSalespersons();

    const salesperson = salespersons.find(
      (item) => String(item.id) === String(salespersonId),
    );

    if (!salesperson) {
      return res.status(404).json({
        success: false,
        message: "Продавец не найден",
      });
    }

    const salesByDate = readSales();

    let found = false;
    let updatedSale = null;

    for (const date of Object.keys(salesByDate)) {
      const sales = salesByDate[date];

      if (!Array.isArray(sales)) {
        continue;
      }

      const saleIndex = sales.findIndex((sale) => sale?.id === saleId);

      if (saleIndex === -1) {
        continue;
      }

      sales[saleIndex] = {
        ...sales[saleIndex],

        salesperson: {
          id: salesperson.id,
          name: salesperson.name,
        },
      };

      updatedSale = sales[saleIndex];
      found = true;

      break;
    }

    if (!found) {
      return res.status(404).json({
        success: false,
        message: "Продажа не найдена",
      });
    }

    writeSales(salesByDate);
    return res.json({
      success: true,
      sale: updatedSale,
    });
  } catch (error) {
    console.error("Ошибка изменения продавца продажи:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Не удалось изменить продавца",
    });
  }
});

/* =========================================================
   START
========================================================= */

app.listen(PORT, () => {
  console.log(`Backend запущен: http://localhost:${PORT}`);

  // console.log(`Retail Store ID: ${RETAIL_STORE_ID || "НЕ УКАЗАН"}`);
});

// возврат
app.post("/api/moysklad/returns", async (req, res) => {
  try {
    const { items, total, retailShiftSyncId, demandId, orderId, payment } =
      req.body;

    const branch = getCurrentBranch();

    const storeId = branch.storeId;
    const retailStoreId = branch.retailStoreId;

    /* ==========================================
       ПРОВЕРКА ТОВАРОВ
    ========================================== */

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Нет товаров для возврата",
      });
    }

    /* ==========================================
       ПРОВЕРКА КАССОВОЙ СМЕНЫ
    ========================================== */

    if (!retailShiftSyncId) {
      return res.status(400).json({
        success: false,
        message: "Открытая кассовая смена не найдена",
      });
    }

    if (!Number.isFinite(Number(total)) || Number(total) <= 0) {
      return res.status(400).json({
        success: false,
        message: "Некорректная сумма возврата",
      });
    }

    const normalizedTotal = Math.round(Number(total) * 100);

    if (!storeId) {
      return res.status(400).json({
        success: false,
        message: "Не указан склад",
      });
    }

    if (!retailStoreId) {
      throw new Error("MOYSKLAD_RETAIL_STORE_ID не указан в .env");
    }

    const organization = await getMoySkladOrganization();

    if (!AGENT) {
      throw new Error("MOYSKLAD_AGENT не указан в .env");
    }

    const shiftFilter = encodeURIComponent(`syncId=${retailShiftSyncId}`);

    const shiftData = await moySkladRequest(
      `/entity/retailshift?filter=${shiftFilter}&limit=1`,
    );

    const retailShift = shiftData.rows?.[0];

    if (!retailShift) {
      throw new Error(
        `Розничная смена с syncId ${retailShiftSyncId} не найдена`,
      );
    }

    /* ==========================================
       ПОИСК ASSORTMENT

       Определяем, является ли позиция:
       - product
       - bundle

       Если type пришёл с frontend,
       сначала проверяем именно его.
    ========================================== */

    const findAssortment = async (item) => {
      if (!item?.id) {
        throw new Error(
          `У товара "${item?.name || "Без названия"}" отсутствует ID МойСклад`,
        );
      }

      const requestedType =
        typeof item.type === "string" ? item.type.toLowerCase() : null;

      const typesToCheck = [];

      /* ------------------------------------------
         Если frontend передал правильный type,
         проверяем его первым
      ------------------------------------------ */

      if (requestedType === "product" || requestedType === "bundle") {
        typesToCheck.push(requestedType);
      }

      /* ------------------------------------------
         Если type неизвестен —
         пробуем оба варианта
      ------------------------------------------ */

      typesToCheck.push("product");
      typesToCheck.push("bundle");

      const uniqueTypes = [...new Set(typesToCheck)];

      console.log(`Проверка ассортимента: "${item.name || "Без названия"}"`, {
        id: item.id,
        requestedType,
        typesToCheck: uniqueTypes,
      });

      /* ==========================================
         ПРОВЕРЯЕМ PRODUCT / BUNDLE
      ========================================== */

      for (const type of uniqueTypes) {
        try {
          console.log(`Проверяем ${type}: ${item.id}`);

          const object = await moySkladRequest(`/entity/${type}/${item.id}`, {
            method: "GET",
          });

          if (object?.id) {
            console.log(`Найден assortment: ${type}`, {
              id: object.id,
              name: object.name,
            });

            return {
              id: object.id,
              type,
              object,
            };
          }
        } catch (checkError) {
          const errorData =
            checkError?.response?.data || checkError?.data || null;

          const errorCode =
            errorData?.errors?.[0]?.code ||
            checkError?.response?.status ||
            checkError?.status ||
            null;

          console.log(`Не найден ${type}: ${item.id}`, {
            errorCode,
            error: errorData?.errors?.[0]?.error || checkError?.message || null,
          });
        }
      }

      /* ==========================================
         ЕСЛИ FRONTEND ПРИСЛАЛ PRODUCTFOLDER
      ========================================== */

      if (requestedType === "productfolder") {
        try {
          const folder = await moySkladRequest(
            `/entity/productfolder/${item.id}`,
            {
              method: "GET",
            },
          );

          if (folder?.id) {
            throw new Error(
              `Объект "${item.name || folder.name || "Без названия"}" ` +
                `является группой товаров (productfolder). ` +
                `Группу нельзя вернуть как отдельную позицию. ` +
                `Нужно передать ID конкретного товара или комплекта внутри группы.`,
            );
          }
        } catch (folderError) {
          if (
            folderError.message &&
            folderError.message.includes(
              "Группу нельзя вернуть как отдельную позицию",
            )
          ) {
            throw folderError;
          }
        }
      }

      /* ==========================================
         НЕ НАЙДЕНО
      ========================================== */

      throw new Error(
        `Объект "${item.name || "Без названия"}" не найден в МойСклад. ` +
          `ID: ${item.id}. ` +
          `Тип из frontend: ${item.type || "не указан"}. ` +
          `Ожидался product или bundle.`,
      );
    };

    /* ==========================================
       ФОРМИРУЕМ ПОЗИЦИИ ВОЗВРАТА
    ========================================== */

    const positions = [];

    for (const item of items) {
      const quantity = Number(item.quantity);

      if (!Number.isFinite(quantity) || quantity <= 0) {
        throw new Error(`Некорректное количество товара "${item.name || ""}"`);
      }

      /* ------------------------------------------
         Цена приходит с frontend в сомах.
         МойСклад принимает цену в копейках.
      ------------------------------------------ */

      const priceSom = Number(item.price || 0);

      if (!Number.isFinite(priceSom) || priceSom < 0) {
        throw new Error(`Некорректная цена товара "${item.name || ""}"`);
      }

      const price = Math.round(priceSom * 100);

      /* ------------------------------------------
         Автоматически определяем:
         product или bundle
      ------------------------------------------ */

      const assortment = await findAssortment(item);

      positions.push({
        quantity,
        price,
        assortment: {
          meta: {
            href: `${MOYSKLAD_API}/entity/${assortment.type}/${assortment.id}`,
            type: assortment.type,
            mediaType: "application/json",
          },
        },
      });
    }

    /* ==========================================
       НОМЕР ВОЗВРАТА
    ========================================== */

    const returnId = `RETURN-${Date.now()}`;

    /* ==========================================
       ДАННЫЕ ВОЗВРАТА
    ========================================== */

    const retailSalesReturnData = {
      name: returnId,

      moment: new Date().toISOString().slice(0, 19).replace("T", " "),

      description: `POS возврат${orderId ? `: ${orderId}` : ""}`,

      /* Организация */

      organization: {
        meta: {
          href: organization.meta.href,
          type: "organization",
          mediaType: "application/json",
        },
      },

      /* Контрагент */

      agent: {
        meta: {
          href: `${MOYSKLAD_API}/entity/counterparty/${AGENT}`,
          type: "counterparty",
          mediaType: "application/json",
        },
      },

      /* Розничная точка */

      retailStore: {
        meta: {
          href: `${MOYSKLAD_API}/entity/retailstore/${retailStoreId}`,
          type: "retailstore",
          mediaType: "application/json",
        },
      },

      /* Склад */

      store: {
        meta: {
          href: `${MOYSKLAD_API}/entity/store/${storeId}`,
          type: "store",
          mediaType: "application/json",
        },
      },

      /* Розничная смена */

      retailShift: {
        meta: {
          href: `${MOYSKLAD_API}/entity/retailshift/${retailShift.id}`,
          type: "retailshift",
          mediaType: "application/json",
        },
      },

      positions,
    };

    /* ==========================================
       СВЯЗЬ С ИСХОДНОЙ ПРОДАЖЕЙ
    ========================================== */

    if (demandId) {
      retailSalesReturnData.demand = {
        meta: {
          href: `${MOYSKLAD_API}/entity/retaildemand/${demandId}`,
          type: "retaildemand",
          mediaType: "application/json",
        },
      };
    }

    /* ==========================================
       ОПЛАТА ВОЗВРАТА
    ========================================== */

    const cash = Number(payment?.cash || 0);
    const card = Number(payment?.card || 0);

    if (
      !Number.isFinite(cash) ||
      !Number.isFinite(card) ||
      cash < 0 ||
      card < 0
    ) {
      throw new Error("Некорректные суммы возврата");
    }

    /* ==========================================
       КОНВЕРТАЦИЯ В КОПЕЙКИ
    ========================================== */

    const cashSum = Math.round(cash * 100);
    const noCashSum = Math.round(card * 100);

    /* ==========================================
       ЕСЛИ PAYMENT НЕ ПЕРЕДАН
    ========================================== */

    if (!payment) {
      retailSalesReturnData.cashSum = normalizedTotal;

      retailSalesReturnData.noCashSum = 0;
    } else {
      if (cashSum + noCashSum !== normalizedTotal) {
        throw new Error(
          `Сумма возврата не совпадает: ` +
            `cashSum=${cashSum}, ` +
            `noCashSum=${noCashSum}, ` +
            `total=${normalizedTotal}`,
        );
      }

      retailSalesReturnData.cashSum = cashSum;

      retailSalesReturnData.noCashSum = noCashSum;
    }

    /* ==========================================
       СУММА ДЛЯ ЛОКАЛЬНОЙ КАССЫ
    ========================================== */

    const localCashSum = payment ? cashSum : normalizedTotal;

    /* ==========================================
       СОЗДАЁМ ВОЗВРАТ В МОЙСКЛАД
    ========================================== */

    console.log(
      "ВОЗВРАТ JSON:",
      JSON.stringify(retailSalesReturnData, null, 2),
    );

    const retailSalesReturn = await moySkladRequest(
      "/entity/retailsalesreturn",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(retailSalesReturnData),
      },
    );

    /* ==========================================
       СПИСЫВАЕМ ДЕНЬГИ ИЗ ЛОКАЛЬНОЙ КАССЫ
    ========================================== */

    let cashTransaction = null;

    if (localCashSum > 0) {
      cashTransaction = addReturnToCash(
        localCashSum,
        orderId || null,
        returnId,
        retailSalesReturn?.id || null,
      );

      console.log("Деньги за возврат списаны из кассы:", cashTransaction);
    } else {
      console.log("Возврат без наличных — cash.json не изменяется");
    }

    /* ==========================================
       СОХРАНЯЕМ В data/returns.json
    ========================================== */

    const RETURNS_FILE = path.join(DATA_DIR, "returns.json");

    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, {
        recursive: true,
      });
    }

    /* Читаем существующие возвраты */

   let returns = readReturns();

    /* ==========================================
       СОЗДАЁМ ЛОКАЛЬНУЮ ЗАПИСЬ
    ========================================== */

    const returnRecord = {
      id: returnId,

      name: returnId,

      date: new Date().toISOString(),

      orderId: orderId || null,

      demandId: demandId || null,

      returnDocumentId: retailSalesReturn?.id || null,

      retailShiftSyncId,

      retailShiftId: retailShift.id,

      storeId,

      total: Number(total),

      payment: {
        cash,
        card,
      },

      cashSum: localCashSum / 100,

      noCashSum: payment ? noCashSum / 100 : 0,

      items: items.map((item) => {
        const quantity = Number(item.quantity);

        const price = Number(item.price || 0);

        return {
          id: item.id,

          name: item.name || "Без названия",

          type: item.type || "product",

          quantity,

          price,

          sum: price * quantity,
        };
      }),
    };

    /* ==========================================
       ДОБАВЛЯЕМ НОВЫЙ ВОЗВРАТ
    ========================================== */

    returns.push(returnRecord);

    /* ==========================================
       СОРТИРОВКА ПО ДАТЕ
    ========================================== */

    returns.sort((a, b) => {
      return new Date(b.date).getTime() - new Date(a.date).getTime();
    });

    /* ==========================================
       СОХРАНЯЕМ returns.json
    ========================================== */

   writeReturns(returns);

    console.log("Возврат сохранён в returns.json:", returnRecord);

    /* ==========================================
       УСПЕШНЫЙ ОТВЕТ
    ========================================== */

    return res.status(201).json({
      success: true,
      returnId,
      returnDocumentId: retailSalesReturn?.id || null,
      total: normalizedTotal,
      cashSum: localCashSum,
      noCashSum: payment ? noCashSum : 0,
      retailShiftSyncId,
      retailShiftId: retailShift.id,
      cashTransaction,
      returnRecord,
      retailSalesReturn,
    });
  } catch (error) {
    console.error("Ошибка создания розничного возврата:", error);

    const moySkladError = error?.response?.data || error?.data || null;

    console.error("Детали ошибки МойСклад:", moySkladError);

    return res.status(500).json({
      success: false,

      message: error.message || "Ошибка создания розничного возврата",

      moySkladError: moySkladError || null,
    });
  }
});

app.get("/api/moysklad/salespersons", (req, res) => {
  try {
    const salespersons = readSalespersons();

    return res.json({
      success: true,
      salespersons,
    });
  } catch (error) {
    console.error("Ошибка получения продавцов:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Не удалось получить список продавцов",
      salespersons: [],
    });
  }
});

app.get("/api/moysklad/debug-auth", async (req, res) => {
  try {
    const token = await authorizeMoySklad();

    const data = await moySkladRequest("/entity/store?limit=100");

    return res.json({
      success: true,
      stores: (data.rows || []).map((store) => ({
        id: store.id,
        name: store.name,
      })),
      branch: getCurrentBranch(),
      tokenExists: Boolean(token),
    });
  } catch (error) {
    console.error("DEBUG AUTH ERROR:", error);

    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});
