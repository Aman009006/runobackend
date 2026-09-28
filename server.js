const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const app = express();

app.use(
  cors({
    origin: "https://runo-rouge.vercel.app",
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

app.use(express.json());

const expensesRouter = require("./expenses");
const amanatRoutes = require("./amanat");

app.use("/api/expenses", expensesRouter);

const transfersRoutes = require("./transfers");

app.use("/api/transfers", transfersRoutes);
const cashRouter = require("./cash.routes");

app.use("/api/moysklad/cash", cashRouter);
app.use("/api/moysklad", amanatRoutes);

const reportsRouter = require("./reports");

app.use("/api/reports", reportsRouter);

const PORT = process.env.PORT || 5000;

const AGENT = process.env.MOYSKLAD_AGENT;

const LOGIN = process.env.MOYSKLAD_LOGIN;
const PASSWORD = process.env.MOYSKLAD_PASSWORD;

const RETAIL_STORE_ID = process.env.MOYSKLAD_RETAIL_STORE_ID;

const MOYSKLAD_API = "https://api.moysklad.ru/api/remap/1.2";

const MOYSKLAD_POS_API = "https://online.moysklad.ru/api/posap/1.0";

const YOUNG_GUARD_ID = "40b43662-2117-11f1-0a80-1cb200302c3c";

const reservationsRouter = require("./reservations.routes");

// =========================================================
// LOCAL SALES STORAGE
// =========================================================

const DATA_DIR = path.join(__dirname, "..", "data");
const SALES_FILE = path.join(DATA_DIR, "sales.json");
const CASH_FILE = path.join(DATA_DIR, "cash.json");
const RETURNS_FILE = path.join(DATA_DIR, "returns.json");


// Создаем папку data
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Создаем sales.json
// ВАЖНО: теперь начальная структура — объект {}, а не []
if (!fs.existsSync(SALES_FILE)) {
  fs.writeFileSync(SALES_FILE, JSON.stringify({}, null, 2), "utf8");
}

// =========================================================
// READ SALES
// =========================================================

function readSales() {
  try {
    const content = fs.readFileSync(SALES_FILE, "utf8");

    if (!content.trim()) {
      return {};
    }

    const sales = JSON.parse(content);

    // Новый формат:
    // {
    //   "2026-09-23": [],
    //   "2026-09-22": []
    // }

    if (sales && typeof sales === "object" && !Array.isArray(sales)) {
      return sales;
    }

    // Если старый формат был массивом,
    // возвращаем пустой объект.
    return {};
  } catch (error) {
    console.error("Ошибка чтения sales.json:", error);

    return {};
  }
}

// =========================================================
// WRITE SALES
// =========================================================

function writeSales(sales) {
  fs.writeFileSync(SALES_FILE, JSON.stringify(sales, null, 2), "utf8");
}

// =========================================================
// SAVE SALE
// =========================================================

function saveSale(sale) {
  try {
    const salesByDate = readSales();

    // -----------------------------------------------------
    // Определяем дату продажи
    // -----------------------------------------------------

    const date = sale.createdAt
      ? sale.createdAt.slice(0, 10)
      : new Date().toISOString().slice(0, 10);

    // -----------------------------------------------------
    // Создаем массив продаж за этот день
    // -----------------------------------------------------

    if (!Array.isArray(salesByDate[date])) {
      salesByDate[date] = [];
    }

    // -----------------------------------------------------
    // Добавляем продажу
    // -----------------------------------------------------

    salesByDate[date].push(sale);

    // -----------------------------------------------------
    // Сохраняем
    // -----------------------------------------------------

    writeSales(salesByDate);

    console.log("================================");
    console.log("ЛОКАЛЬНАЯ ПРОДАЖА СОХРАНЕНА");
    console.log("Файл:", SALES_FILE);
    console.log("Дата:", date);
    console.log("ID:", sale.id);
    console.log("Продаж за этот день:", salesByDate[date].length);
    console.log("================================");

    return sale;
  } catch (error) {
    console.error("Ошибка сохранения локальной продажи:", error);

    throw error;
  }
}

// =========================================================
// ADD SALE CASH TO CASH.JSON
// =========================================================

function addSaleToCash(cashSum, salesperson) {
  try {
    // Если наличной оплаты нет — ничего не делаем
    if (!cashSum || cashSum <= 0) {
      return null;
    }

    // Читаем cash.json
    let cashData = {
      balance: 0,
      transactions: [],
    };

    if (fs.existsSync(CASH_FILE)) {
      const content = fs.readFileSync(CASH_FILE, "utf8");

      if (content.trim()) {
        cashData = JSON.parse(content);
      }
    }

    // Проверяем структуру
    if (!Array.isArray(cashData.transactions)) {
      cashData.transactions = [];
    }

    if (typeof cashData.balance !== "number") {
      cashData.balance = 0;
    }

    // cashSum приходит в копейках
    // Баланс cash.json хранится в сомах
    const amountSom = cashSum / 100;

    // Баланс до операции
    const balanceBefore = cashData.balance;

    // Новый баланс
    const balanceAfter = balanceBefore + amountSom;

    // Создаём историю транзакции
    const transaction = {
      id: `CASH-SALE-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,

      type: "sale",

      amount: amountSom,

      balanceBefore,

      balanceAfter,

      responsible:
        typeof salesperson === "object"
          ? salesperson.name || "Не указан"
          : salesperson || "Не указан",

      comment: "Оплата розничной продажи",

      createdAt: new Date().toISOString(),
    };

    // Обновляем баланс
    cashData.balance = balanceAfter;

    // Добавляем транзакцию
    cashData.transactions.push(transaction);

    // Сохраняем cash.json
    fs.writeFileSync(CASH_FILE, JSON.stringify(cashData, null, 2), "utf8");

    console.log("================================");
    console.log("НАЛИЧНАЯ ОПЛАТА ДОБАВЛЕНА В КАССУ");
    console.log("Сумма:", amountSom, "сом");
    console.log("Баланс до:", balanceBefore);
    console.log("Баланс после:", balanceAfter);
    console.log("Транзакция:", transaction.id);
    console.log("================================");

    return transaction;
  } catch (error) {
    console.error("Ошибка добавления продажи в cash.json:", error);

    throw error;
  }
}

// =========================================================
// ADD RETURN CASH TO CASH.JSON
// =========================================================

function addReturnToCash(cashSum, orderId, returnId, returnDocumentId) {
  try {
    // Если наличного возврата нет — ничего не делаем
    if (!cashSum || cashSum <= 0) {
      return null;
    }

    // Читаем cash.json
    let cashData = {
      balance: 0,
      transactions: [],
    };

    if (fs.existsSync(CASH_FILE)) {
      const content = fs.readFileSync(CASH_FILE, "utf8");

      if (content.trim()) {
        cashData = JSON.parse(content);
      }
    }

    // Проверяем структуру
    if (!Array.isArray(cashData.transactions)) {
      cashData.transactions = [];
    }

    if (typeof cashData.balance !== "number") {
      cashData.balance = 0;
    }

    // cashSum приходит в копейках
    // cash.json хранит баланс в сомах
    const amountSom = cashSum / 100;

    // Баланс до возврата
    const balanceBefore = cashData.balance;

    // Проверяем, хватает ли денег
    // if (balanceBefore < amountSom) {
    //   throw new Error(
    //     `Недостаточно денег в кассе для возврата. ` +
    //       `Баланс: ${balanceBefore} сом, ` +
    //       `требуется: ${amountSom} сом`,
    //   );
    // }

    // Новый баланс
    const balanceAfter = balanceBefore - amountSom;

    // Создаём транзакцию
    const transaction = {
      id: `CASH-RETURN-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,

      type: "return",

      // Возврат денег — отрицательная сумма
      amount: -amountSom,

      balanceBefore,

      balanceAfter,

      orderId: orderId || null,

      returnId: returnId || null,

      returnDocumentId: returnDocumentId || null,

      comment: "Возврат денег за товар",

      createdAt: new Date().toISOString(),
    };

    // Обновляем баланс
    cashData.balance = balanceAfter;

    // Добавляем историю
    cashData.transactions.push(transaction);

    // Сохраняем
    fs.writeFileSync(CASH_FILE, JSON.stringify(cashData, null, 2), "utf8");

    console.log("================================");
    console.log("ВОЗВРАТ ДЕНЕГ ИЗ КАССЫ");
    console.log("Сумма:", amountSom, "сом");
    console.log("Баланс до:", balanceBefore);
    console.log("Баланс после:", balanceAfter);
    console.log("Транзакция:", transaction.id);
    console.log("================================");

    return transaction;
  } catch (error) {
    console.error("Ошибка возврата денег из cash.json:", error);

    throw error;
  }
}
// =========================================================
// GET LOCAL SALES
// =========================================================

// =========================================================
// GET LOCAL SALES
// =========================================================

app.get("/api/moysklad/sales", (req, res) => {
  try {
    const salesByDate = readSales();

    // -----------------------------------------------------
    // Превращаем продажи из объекта в единый массив
    // -----------------------------------------------------

    const allSales = Object.entries(salesByDate).flatMap(([date, sales]) =>
      sales.map((sale) => ({
        ...sale,
        date,
      })),
    );

    // -----------------------------------------------------
    // Сортируем от новых к старым
    // -----------------------------------------------------

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

let posAuthToken = null;
let posCashierUid = null;

/* =========================================================
   POS AUTH
========================================================= */

async function getPosAuth() {
  if (posAuthToken && posCashierUid) {
    return {
      token: posAuthToken,
      uid: posCashierUid,
    };
  }

  if (!LOGIN || !PASSWORD) {
    throw new Error("MOYSKLAD_LOGIN или MOYSKLAD_PASSWORD не указаны в .env");
  }

  if (!RETAIL_STORE_ID) {
    throw new Error("MOYSKLAD_RETAIL_STORE_ID не указан в .env");
  }

  console.log("Получаем POS token МойСклад...");

  const credentials = Buffer.from(`${LOGIN}:${PASSWORD}`).toString("base64");

  const response = await fetch(
    `${MOYSKLAD_POS_API}/admin/attach/${RETAIL_STORE_ID}`,
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
      `Ошибка получения POS token: ${response.status} ${errorText}`,
    );
  }

  const data = await response.json();

  if (!data.token) {
    throw new Error("МойСклад не вернул POS token");
  }

  if (!data.uid) {
    throw new Error("МойСклад не вернул UID кассира");
  }

  posAuthToken = data.token;
  posCashierUid = data.uid;

  console.log("POS token успешно получен");

  console.log("POS cashier UID:", posCashierUid);

  return {
    token: posAuthToken,
    uid: posCashierUid,
  };
}

/* =========================================================
   OPEN RETAIL SHIFT
========================================================= */

async function openRetailShift() {
  const { token, uid } = await getPosAuth();

  const retailShiftSyncId = crypto.randomUUID();

  const shiftName = `POS-${Date.now()}`;

  const openMoment = new Date().toISOString().slice(0, 19).replace("T", " ");

  console.log("================================");

  console.log("ОТКРЫТИЕ СМЕНЫ");

  console.log("retailStore:", RETAIL_STORE_ID);

  console.log("retailShiftSyncId:", retailShiftSyncId);

  console.log("shiftName:", shiftName);

  console.log("cashierUid:", uid);

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
      posAuthToken = null;
      posCashierUid = null;
    }

    throw new Error(
      `Ошибка открытия смены МойСклад: ${response.status} ${errorText}`,
    );
  }

  console.log("Смена успешно открыта");

  console.log("================================");

  return {
    success: true,

    retailShiftSyncId,

    shiftName,

    openMoment,

    retailStoreId: RETAIL_STORE_ID,
  };
}

/* =========================================================
   CLOSE RETAIL SHIFT
========================================================= */

async function closeRetailShift(retailShiftSyncId) {
  if (!retailShiftSyncId) {
    throw new Error("Не указан retailShiftSyncId");
  }

  const { token, uid } = await getPosAuth();

  const closeMoment = new Date().toISOString().slice(0, 19).replace("T", " ");

  console.log("================================");

  console.log("ЗАКРЫТИЕ СМЕНЫ");

  console.log("retailShiftSyncId:", retailShiftSyncId);

  console.log("cashierUid:", uid);

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
      posAuthToken = null;
      posCashierUid = null;
    }

    throw new Error(
      `Ошибка закрытия смены МойСклад: ${response.status} ${errorText}`,
    );
  }

  console.log("Смена успешно закрыта");

  console.log("================================");

  return {
    success: true,

    retailShiftSyncId,

    closeMoment,

    retailStoreId: RETAIL_STORE_ID,
  };
}

/* =========================================================
   MOYSKLAD AUTH
========================================================= */

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

  console.log("Авторизация в МойСклад успешна");

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
    console.log("Получаем новый токен МойСклад...");

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

/* =========================================================
   HEALTH
========================================================= */

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,

    message: "Backend работает",
  });
});

/* =========================================================
   OPEN SHIFT
========================================================= */

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
    console.log("Получаем список складов...");

    const data = await moySkladRequest("/entity/store?limit=100");

    const stores = (data.rows || []).map((store) => ({
      id: store.id,

      name: store.name || "Склад без названия",

      pathName: store.pathName || "",

      address: store.address || "",
    }));

    console.log(`Получено складов: ${stores.length}`);

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
    console.log("Получаем розничные точки...");

    const data = await moySkladRequest("/entity/retailstore?limit=100");

    const retailStores = (data.rows || []).map((retailStore) => ({
      id: retailStore.id,

      name: retailStore.name || "Розничная точка без названия",

      address: retailStore.address || "",

      active: retailStore.active,

      meta: retailStore.meta || null,
    }));

    console.log(`Получено розничных точек: ${retailStores.length}`);

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

/* =========================================================
   PRODUCTS
========================================================= */

/* =========================================================
   РАССЧИТАТЬ ОСТАТОК КОМПЛЕКТА
========================================================= */

async function calculateBundleStock(bundle, stockRows) {
  try {
    const bundleId = bundle.id;

    if (!bundleId) {
      return 0;
    }

const components = await getBundleComponents(bundleId);

    if (components.length === 0) {
      console.log(
        `Комплект "${bundle.name}" не имеет компонентов`,
      );

      return 0;
    }

    let possibleBundles = Infinity;

    for (const component of components) {
      const componentQuantity = Number(component.quantity || 0);

      if (
        !Number.isFinite(componentQuantity) ||
        componentQuantity <= 0
      ) {
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

      /*
       * ID товара/модификации
       */

      const componentHref = componentMeta.href
        .split("?")[0];

      const componentId = componentHref
        .split("/")
        .pop();

      /*
       * Ищем остаток компонента
       */

      const stockItem = stockRows.find((item) => {
        const href = item.meta?.href
          ?.split("?")[0];

        const id = href?.split("/").pop();

        return (
          id === componentId &&
          (
            item.meta?.type === componentMeta.type ||
            !componentMeta.type
          )
        );
      });

      const stock = Number(stockItem?.stock || 0);

      /*
       * Сколько комплектов можно собрать
       * из этого компонента
       */

      const componentBundles =
        Math.floor(stock / componentQuantity);

      possibleBundles = Math.min(
        possibleBundles,
        componentBundles,
      );

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
    console.error(
      `Ошибка расчёта остатка комплекта "${bundle.name}":`,
      error,
    );

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

  if (
    cached &&
    Date.now() - cached.timestamp < BUNDLE_CACHE_TTL
  ) {
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
async function refreshProductsCache(storeId) {
  /*
   * =====================================================
   * ЕСЛИ ОБНОВЛЕНИЕ УЖЕ ИДЁТ
   * =====================================================
   */

  if (productsLoading.has(storeId)) {
    console.log(
      `PRODUCTS: обновление уже выполняется для ${storeId}`,
    );

    return productsLoading.get(storeId);
  }

  /*
   * =====================================================
   * СОЗДАЁМ PROMISE ОБНОВЛЕНИЯ
   * =====================================================
   */

  const loadingPromise = (async () => {
    try {
      console.log("================================");
      console.log("ОБНОВЛЕНИЕ PRODUCTS");
      console.log("Store:", storeId);
      console.log("================================");

      const storeHref =
        `${MOYSKLAD_API}/entity/store/${storeId}`;

      const filterParam = encodeURIComponent(
        `store=${storeHref}`,
      );

      /*
       * =================================================
       * 1. ОСТАТКИ
       * =================================================
       */

      const stockData = await moySkladRequest(
        `/report/stock/all?filter=${filterParam}&limit=1000`,
      );

      const stockRows = stockData?.rows || [];

      console.log(
        `Получено товаров со склада: ${stockRows.length}`,
      );

      /*
       * =================================================
       * 2. КОМПЛЕКТЫ
       * =================================================
       */

      const bundleData = await moySkladRequest(
        `/entity/bundle?limit=1000`,
      );

      const bundles = bundleData?.rows || [];

      console.log(
        `Получено комплектов: ${bundles.length}`,
      );

      /*
       * =================================================
       * 3. ОБЫЧНЫЕ ТОВАРЫ
       * =================================================
       */

      const products = stockRows.map((item) => {
        const rawHref = item.meta?.href || "";

        const cleanHref = rawHref.split("?")[0];

        const productId =
          cleanHref.split("/").pop() || "";

        const price = item.salePrice
          ? item.salePrice / 100
          : 0;

        const buyPrice = item.price
          ? item.price / 100
          : 0;

        const costPrice = item.price
          ? item.price / 100
          : 0;

        return {
          id: productId,

          name: item.name || "Товар без названия",

          code: item.code || "",

          article: item.article || "",

          price,

          buyPrice,

          costPrice,

          stock: Number(item.stock || 0),

          reserve: Number(item.reserve || 0),

          inTransit: Number(item.inTransit || 0),

          reserveStock: Number(
            item.reserveStock || 0,
          ),

          meta: item.meta,

          uom:
            item.uom?.name || "шт",

          pathName:
            item.folder?.name ||
            item.productFolder?.name ||
            "Общая категория",

          description:
            item.description || "",

          type:
            item.meta?.type || "product",

          isBundle: false,
        };
      });

      /*
       * =================================================
       * 4. КОМПЛЕКТЫ
       * =================================================
       */

      const bundleProducts = [];

      for (const bundle of bundles) {
        try {
          const rawHref =
            bundle.meta?.href || "";

          const cleanHref =
            rawHref.split("?")[0];

          const bundleId =
            cleanHref.split("/").pop() || "";

          const price =
            bundle.salePrices?.[0]?.value != null
              ? bundle.salePrices[0].value / 100
              : 0;

          const buyPrice =
            bundle.buyPrice != null
              ? bundle.buyPrice / 100
              : 0;

          const stock =
            await calculateBundleStock(
              bundle,
              stockRows,
            );

          bundleProducts.push({
            id: bundleId,

            name:
              bundle.name ||
              "Комплект без названия",

            code: bundle.code || "",

            article: bundle.article || "",

            price,

            buyPrice,

            costPrice: buyPrice,

            stock,

            reserve: 0,

            inTransit: 0,

            meta: bundle.meta,

            uom:
              bundle.uom?.name || "шт",

            pathName:
              bundle.productFolder?.name ||
              bundle.folder?.name ||
              "Общая категория",

            description:
              bundle.description || "",

            type: "bundle",

            isBundle: true,
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
       * 5. ОБЪЕДИНЯЕМ
       * =================================================
       */

      const allProducts = [
        ...products,
        ...bundleProducts,
      ];

      /*
       * =================================================
       * ВАЖНО:
       * НЕ СОХРАНЯЕМ ПУСТОЙ РЕЗУЛЬТАТ
       * =================================================
       */

      if (
        allProducts.length === 0
      ) {
        throw new Error(
          "МойСклад вернул пустой список товаров",
        );
      }

      const result = {
        storeId,

        storeName:
          "Молодая Гвардия 41",

        total:
          allProducts.length,

        productsCount:
          products.length,

        bundlesCount:
          bundleProducts.length,

        rows:
          allProducts,
      };

      /*
       * =================================================
       * СОХРАНЯЕМ В КЭШ
       * =================================================
       */

      productsCache.set(storeId, {
        timestamp: Date.now(),

        data: result,
      });

      console.log("================================");
      console.log("PRODUCTS CACHE ОБНОВЛЁН");
      console.log("Store:", storeId);
      console.log(
        "Товаров:",
        allProducts.length,
      );
      console.log("================================");

      return result;
    } catch (error) {
      /*
       * =================================================
       * ЕСЛИ МОЙСКЛАД ДАЛ 429 / ОШИБКУ
       * =================================================
       *
       * Старый cache НЕ ТРОГАЕМ.
       */

      console.error(
        "Ошибка обновления products:",
        error.message,
      );

      throw error;
    } finally {
      productsLoading.delete(storeId);
    }
  })();

  /*
   * Запоминаем текущий Promise.
   *
   * Если frontend сделает 5 запросов подряд,
   * все будут ждать ОДИН запрос.
   */

  productsLoading.set(
    storeId,
    loadingPromise,
  );

  return loadingPromise;
}

async function forceRefreshProductsCache(storeId = YOUNG_GUARD_ID) {
  console.log(`🔄 Принудительное обновление товаров: ${storeId}`);

  try {
    const data = await refreshProductsCache(storeId);

    console.log(
      `✅ Кеш товаров обновлён: ${data?.rows?.length || 0} товаров`,
    );

    return {
      success: true,
      data,
      cached: false,
      cacheAge: 0,
    };
  } catch (error) {
    console.error(
      `❌ Ошибка принудительного обновления кеша:`,
      error.message,
    );

    throw error;
  }
}

app.get("/api/moysklad/products", async (req, res) => {
  const storeId = req.query.storeId || YOUNG_GUARD_ID;

  const cached = productsCache.get(storeId);

  /*
   * =====================================================
   * ЕСЛИ ЕСТЬ КЭШ
   * =====================================================
   */

  if (cached) {
    const cacheAge = Date.now() - cached.timestamp;

    console.log(
      `PRODUCT CACHE: ${storeId}, возраст ${Math.round(
        cacheAge / 1000,
      )} сек`,
    );

    /*
     * Сразу отдаём старые данные.
     * НИКОГДА не показываем белый экран.
     */

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
    console.error(
      "Ошибка первого получения товаров:",
      error,
    );

    return res.status(500).json({
      success: false,

      message:
        error.message ||
        "Ошибка получения товаров МойСклад",
    });
  }
});

app.post("/api/moysklad/products/refresh", async (req, res) => {
  const storeId = req.body?.storeId || YOUNG_GUARD_ID;

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

  console.log("Организация МойСклад:", organization.name);

  return organization;
}

/* =========================================================
   GET COUNTERPARTIES
========================================================= */

app.get("/api/moysklad/counterparties", async (req, res) => {
  try {
    console.log("Получаем список контрагентов...");

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

    console.log(`Получено контрагентов: ${counterparties.length}`);

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

  const values = [
    cash,
    card,
    amanat,
    mplus,
    online_qr,
  ];

  if (
    values.some(
      (value) =>
        !Number.isFinite(value) || value < 0,
    )
  ) {
    throw new Error(
      "Суммы оплаты должны быть положительными числами",
    );
  }

  const paymentTotal =
    cash +
    card +
    amanat +
    mplus +
    online_qr;

  if (
    Math.round(paymentTotal) !==
    Math.round(total)
  ) {
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

      storeId = YOUNG_GUARD_ID,

      retailShiftSyncId,
    } = req.body;

    console.log("================================");

    console.log("Создание РОЗНИЧНОЙ ПРОДАЖИ:", orderId);

    console.log("Сумма:", total);

    console.log("Оплата:", payment);

    console.log("Смена:", retailShiftSyncId);

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

    const retailStoreId = RETAIL_STORE_ID;

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

  const cashSum =
  normalizedPayment.cash;

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

    /* -----------------------------------------
         ПОЛУЧАЕМ RETAIL SHIFT
      ----------------------------------------- */

    console.log("Ищем retailShift по syncId:", retailShiftSyncId);

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

    console.log("Retail Shift native ID:", retailShift.id);

    /* -----------------------------------------
         RETAIL DEMAND
      ----------------------------------------- */

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
         ЛОГ
      ----------------------------------------- */

    console.log("================================");

    console.log("РОЗНИЧНАЯ ПРОДАЖА");

    console.log("cashSum:", cashSum);

    console.log("noCashSum:", noCashSum);

    console.log("amanat:", normalizedPayment.amanat);

    console.log("mplus:", normalizedPayment.mplus);

    console.log("retailShift:", retailShift.id);

    console.log("JSON:", JSON.stringify(retailDemandData, null, 2));

    console.log("================================");

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

    console.log("Розничная продажа создана:", retailDemand.id);

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
      retailStoreId: "Боконбаева 222",
      retailShiftSyncId: "Боконбаева 222",

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
      );

      console.log("Продажа сохранена локально:", localSale.id);

      console.log(
        "Транзакция кассы:",
        cashTransaction?.id || "Без наличной оплаты",
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

    console.log("================================");

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

    console.log("================================");

    return res.status(500).json({
      success: false,

      message: error.message || "Ошибка создания розничной продажи",
    });
  }
});

/* =========================================================
   START
========================================================= */

app.listen(PORT, () => {
  console.log(`Backend запущен: http://localhost:${PORT}`);

  console.log(`Retail Store ID: ${RETAIL_STORE_ID || "НЕ УКАЗАН"}`);
});

// возврат
app.post("/api/moysklad/returns", async (req, res) => {
  try {
    const {
      items,
      total,
      retailShiftSyncId,
      demandId,
      orderId,
      payment,
      storeId = YOUNG_GUARD_ID,
    } = req.body;

    console.log("================================");
    console.log("Создание РОЗНИЧНОГО ВОЗВРАТА");
    console.log("Товары:", items);
    console.log("Сумма:", total);
    console.log("Смена:", retailShiftSyncId);
    console.log("Исходная продажа:", demandId);
    console.log("Оплата:", payment);
    console.log("Склад:", storeId);

    /*
     * ==========================================
     * ПРОВЕРКА ТОВАРОВ
     * ==========================================
     */

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Нет товаров для возврата",
      });
    }

    /*
     * ==========================================
     * ПРОВЕРКА КАССОВОЙ СМЕНЫ
     * ==========================================
     */

    if (!retailShiftSyncId) {
      return res.status(400).json({
        success: false,
        message: "Открытая кассовая смена не найдена",
      });
    }

    /*
     * ==========================================
     * ПРОВЕРКА СУММЫ
     * ==========================================
     *
     * total приходит с frontend в сомах.
     *
     * Например:
     *
     * total = 5000
     *
     * В МойСклад:
     *
     * 500000 копеек
     */

    if (!Number.isFinite(Number(total)) || Number(total) <= 0) {
      return res.status(400).json({
        success: false,
        message: "Некорректная сумма возврата",
      });
    }

    const normalizedTotal = Math.round(Number(total) * 100);

    /*
     * ==========================================
     * ПРОВЕРКА СКЛАДА
     * ==========================================
     */

    if (!storeId) {
      return res.status(400).json({
        success: false,
        message: "Не указан склад",
      });
    }

    /*
     * ==========================================
     * ПРОВЕРКА РОЗНИЧНОЙ ТОЧКИ
     * ==========================================
     */

    const retailStoreId = RETAIL_STORE_ID;

    if (!retailStoreId) {
      throw new Error("MOYSKLAD_RETAIL_STORE_ID не указан в .env");
    }

    /*
     * ==========================================
     * ПОЛУЧАЕМ ОРГАНИЗАЦИЮ
     * ==========================================
     */

    const organization = await getMoySkladOrganization();

    /*
     * ==========================================
     * ПРОВЕРЯЕМ КОНТРАГЕНТА
     * ==========================================
     */

    if (!AGENT) {
      throw new Error("MOYSKLAD_AGENT не указан в .env");
    }

    /*
     * ==========================================
     * НАХОДИМ РОЗНИЧНУЮ СМЕНУ
     * ==========================================
     */

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

    /*
     * ==========================================
     * ФОРМИРУЕМ ПОЗИЦИИ ВОЗВРАТА
     * ==========================================
     */

    const positions = items.map((item) => {
      if (!item.id) {
        throw new Error(
          `У товара "${item.name || "Без названия"}" отсутствует ID МойСклад`,
        );
      }

      const quantity = Number(item.quantity);

      if (!Number.isFinite(quantity) || quantity <= 0) {
        throw new Error(
          `Некорректное количество товара "${item.name || ""}"`,
        );
      }

      const type = item.type || "product";

      /*
       * Цена приходит с frontend в сомах.
       *
       * МойСклад принимает цену в копейках.
       */

      const price = Math.round(Number(item.price || 0) * 100);

      if (!Number.isFinite(price) || price < 0) {
        throw new Error(
          `Некорректная цена товара "${item.name || ""}"`,
        );
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

    /*
     * ==========================================
     * НОМЕР ВОЗВРАТА
     * ==========================================
     */

    const returnId = `RETURN-${Date.now()}`;

    /*
     * ==========================================
     * ДАННЫЕ ВОЗВРАТА
     * ==========================================
     */

    const retailSalesReturnData = {
      name: returnId,

      moment: new Date()
        .toISOString()
        .slice(0, 19)
        .replace("T", " "),

      description: `POS возврат${orderId ? `: ${orderId}` : ""}`,

      /*
       * Организация
       */
      organization: {
        meta: {
          href: organization.meta.href,

          type: "organization",

          mediaType: "application/json",
        },
      },

      /*
       * Контрагент
       */
      agent: {
        meta: {
          href: `${MOYSKLAD_API}/entity/counterparty/${AGENT}`,

          type: "counterparty",

          mediaType: "application/json",
        },
      },

      /*
       * Розничная точка
       */
      retailStore: {
        meta: {
          href: `${MOYSKLAD_API}/entity/retailstore/${retailStoreId}`,

          type: "retailstore",

          mediaType: "application/json",
        },
      },

      /*
       * Склад
       */
      store: {
        meta: {
          href: `${MOYSKLAD_API}/entity/store/${storeId}`,

          type: "store",

          mediaType: "application/json",
        },
      },

      /*
       * Розничная смена
       */
      retailShift: {
        meta: {
          href: `${MOYSKLAD_API}/entity/retailshift/${retailShift.id}`,

          type: "retailshift",

          mediaType: "application/json",
        },
      },

      positions,
    };

    /*
     * ==========================================
     * СВЯЗЬ С ИСХОДНОЙ ПРОДАЖЕЙ
     * ==========================================
     */

    if (demandId) {
      retailSalesReturnData.demand = {
        meta: {
          href: `${MOYSKLAD_API}/entity/retaildemand/${demandId}`,

          type: "retaildemand",

          mediaType: "application/json",
        },
      };
    }

    /*
     * ==========================================
     * ОПЛАТА ВОЗВРАТА
     * ==========================================
     *
     * Frontend:
     *
     * cash = сомы
     * card = сомы
     *
     * МойСклад:
     *
     * cashSum = копейки
     * noCashSum = копейки
     */

    const cash = Number(payment?.cash || 0);

    const card = Number(payment?.card || 0);

    /*
     * Проверяем суммы
     */

    if (
      !Number.isFinite(cash) ||
      !Number.isFinite(card) ||
      cash < 0 ||
      card < 0
    ) {
      throw new Error("Некорректные суммы возврата");
    }

    /*
     * Конвертируем в копейки
     */

    const cashSum = Math.round(cash * 100);

    const noCashSum = Math.round(card * 100);

    /*
     * ==========================================
     * ЕСЛИ PAYMENT НЕ ПЕРЕДАН
     * ==========================================
     *
     * Считаем возврат полностью наличным.
     */

    if (!payment) {
      retailSalesReturnData.cashSum = normalizedTotal;

      retailSalesReturnData.noCashSum = 0;
    } else {
      /*
       * Проверяем совпадение суммы
       */

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

    /*
     * ==========================================
     * ОПРЕДЕЛЯЕМ СУММУ ДЛЯ ЛОКАЛЬНОЙ КАССЫ
     * ==========================================
     *
     * Только наличные уменьшают cash.json.
     */

    const localCashSum = payment
      ? cashSum
      : normalizedTotal;

    console.log(
      "Сумма возврата наличными для cash.json:",
      localCashSum / 100,
      "сом",
    );

    /*
     * ==========================================
     * СОЗДАЁМ ВОЗВРАТ В МОЙСКЛАД
     * ==========================================
     */

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

    /*
     * ==========================================
     * СПИСЫВАЕМ ДЕНЬГИ ИЗ ЛОКАЛЬНОЙ КАССЫ
     * ==========================================
     */

    let cashTransaction = null;

    if (localCashSum > 0) {
      cashTransaction = addReturnToCash(
        localCashSum,
        orderId || null,
        returnId,
        retailSalesReturn?.id || null,
      );

      console.log(
        "Деньги за возврат списаны из кассы:",
        cashTransaction,
      );
    } else {
      console.log(
        "Возврат без наличных — cash.json не изменяется",
      );
    }

    /*
     * ==========================================
     * СОХРАНЯЕМ ВОЗВРАТ В data/returns.json
     * ==========================================
     */

    // const DATA_DIR = path.join(__dirname, "data");
    const RETURNS_FILE = path.join(DATA_DIR, "returns.json");

    /*
     * Создаём data, если папки нет
     */

    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, {
        recursive: true,
      });
    }

    /*
     * Читаем существующие возвраты
     */

    let returns = [];

    if (fs.existsSync(RETURNS_FILE)) {
      try {
        const fileData = fs.readFileSync(
          RETURNS_FILE,
          "utf8",
        );

        if (fileData.trim()) {
          returns = JSON.parse(fileData);
        }

        if (!Array.isArray(returns)) {
          returns = [];
        }
      } catch (fileError) {
        console.error(
          "Ошибка чтения returns.json:",
          fileError,
        );

        returns = [];
      }
    }

    /*
     * ==========================================
     * СОЗДАЁМ ЛОКАЛЬНУЮ ЗАПИСЬ
     * ==========================================
     *
     * Здесь суммы хранятся в СОМАХ,
     * чтобы frontend мог сразу использовать их.
     */

    const returnRecord = {
      id: returnId,

      name: returnId,

      date: new Date().toISOString(),

      orderId: orderId || null,

      demandId: demandId || null,

      returnDocumentId:
        retailSalesReturn?.id || null,

      retailShiftSyncId,

      retailShiftId: retailShift.id,

      storeId,

      total: Number(total),

      payment: {
        cash,
        card,
      },

      cashSum: localCashSum / 100,

      noCashSum: payment
        ? noCashSum / 100
        : 0,

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

    /*
     * Добавляем новый возврат
     */

    returns.push(returnRecord);

    /*
     * ==========================================
     * СОРТИРОВКА ПО ДАТЕ
     * ==========================================
     *
     * Новые возвраты сверху.
     */

    returns.sort((a, b) => {
      return (
        new Date(b.date).getTime() -
        new Date(a.date).getTime()
      );
    });

    /*
     * ==========================================
     * СОХРАНЯЕМ returns.json
     * ==========================================
     */

    fs.writeFileSync(
      RETURNS_FILE,
      JSON.stringify(returns, null, 2),
      "utf8",
    );

    console.log(
      "Возврат сохранён в returns.json:",
      returnRecord,
    );

    /*
     * ==========================================
     * УСПЕШНЫЙ ОТВЕТ
     * ==========================================
     */

    return res.status(201).json({
      success: true,

      returnId,

      returnDocumentId:
        retailSalesReturn?.id || null,

      /*
       * Общая сумма в копейках
       */
      total: normalizedTotal,

      /*
       * Наличные в копейках
       */
      cashSum: localCashSum,

      /*
       * Безналичные в копейках
       */
      noCashSum: payment
        ? noCashSum
        : 0,

      retailShiftSyncId,

      retailShiftId: retailShift.id,

      /*
       * Локальная операция с кассой
       */
      cashTransaction,

      /*
       * Локальная запись возврата
       */
      returnRecord,

      retailSalesReturn,
    });
  } catch (error) {
    console.error(
      "Ошибка создания розничного возврата:",
      error,
    );

    /*
     * Если ошибка пришла от МойСклад,
     * показываем её максимально подробно.
     */

    const moySkladError =
      error?.response?.data ||
      error?.data;

    console.error(
      "Детали ошибки МойСклад:",
      moySkladError,
    );

    return res.status(500).json({
      success: false,

      message:
        error.message ||
        "Ошибка создания розничного возврата",

      moySkladError:
        moySkladError || null,
    });
  }
});

/*
 * ==========================================
 * ПРОДАВЦЫ
 * ==========================================
 *
 * Здесь вручную добавляешь продавцов.
 *
 * id должен быть уникальным.
 */

const SALESPERSONS = [
  {
    id: "seller001",
    name: "Айсырга",
  },
  {
    id: "seller002",
    name: "Айжамал",
  },
  {
    id: "seller003",
    name: "Турсунай",
  },
  {
    id: "seller004",
    name: "Рапия",
  },
  {
    id: "seller005",
    name: "Камила",
  },
  {
    id: "seller006",
    name: "Зинаида",
  },
  {
    id: "seller007",
    name: "Мээрим",
  },
  {
    id: "seller008",
    name: "Перизат",
  },
  {
    id: "seller009",
    name: "Сайрагуль",
  },
  {
    id: "seller010",
    name: "Назик",
  },
  {
    id: "seller011",
    name: "Бермет",
  },
  {
    id: "seller012",
    name: "Аида",
  },
  {
    id: "seller013",
    name: "Малика",
  },
  {
    id: "seller014",
    name: "Сезим",
  },
];

app.get("/api/moysklad/salespersons", (req, res) => {
  res.json({
    salespersons: SALESPERSONS,
  });
});
