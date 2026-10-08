const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const { getCurrentBranch } = require("./branchContext");

const router = express.Router();

const DATA_DIR = path.join(__dirname, "..", "data");
const RESERVATIONS_FILE = path.join(DATA_DIR, "reservations.json");
const CASH_FILE = path.join(DATA_DIR, "cash.json");

const BRANCHES = ["bishkek", "dordoy", "osh"];

// Добавили online_qr
const PAYMENT_KEYS = ["cash", "card", "amanat", "mplus", "online_qr"];

const PORT = process.env.PORT || 3000;

const AGENT = process.env.MOYSKLAD_AGENT;

const LOGIN = process.env.MOYSKLAD_LOGIN;
const PASSWORD = process.env.MOYSKLAD_PASSWORD;

const RETAIL_STORE_ID = process.env.MOYSKLAD_RETAIL_STORE_ID;

const MOYSKLAD_API = "https://api.moysklad.ru/api/remap/1.2";

const MOYSKLAD_POS_API = "https://online.moysklad.ru/api/posap/1.0";

const YOUNG_GUARD_ID = "40b43662-2117-11f1-0a80-1cb200302c3c";

/**
 * ==========================================
 * ФИЛИАЛ
 * ==========================================
 */

function getBranchKey() {
  const branch = getCurrentBranch();

  if (!branch?.id) {
    throw new Error("Текущий филиал не определён");
  }

  const branchKey = String(branch.id).trim().toLowerCase();

  if (!BRANCHES.includes(branchKey)) {
    throw new Error(
      `Неизвестный филиал: ${branchKey}. Ожидался: bishkek, dordoy или osh`,
    );
  }

  return branchKey;
}

/**
 * ==========================================
 * STORAGE RESERVATIONS
 * ==========================================
 */

function createEmptyReservationsData() {
  return {
    bishkek: [],
    dordoy: [],
    osh: [],
  };
}

function isBranchReservationsFormat(data) {
  return (
    data &&
    typeof data === "object" &&
    !Array.isArray(data) &&
    (Object.prototype.hasOwnProperty.call(data, "bishkek") ||
      Object.prototype.hasOwnProperty.call(data, "dordoy") ||
      Object.prototype.hasOwnProperty.call(data, "osh"))
  );
}

async function ensureStorage() {
  await fs.mkdir(DATA_DIR, {
    recursive: true,
  });

  try {
    await fs.access(RESERVATIONS_FILE);
  } catch {
    await fs.writeFile(
      RESERVATIONS_FILE,
      JSON.stringify(createEmptyReservationsData(), null, 2),
      "utf8",
    );
  }
}

async function readReservations() {
  await ensureStorage();

  const branchKey = getBranchKey();

  const content = await fs.readFile(RESERVATIONS_FILE, "utf8");

  if (!content.trim()) {
    const emptyData = createEmptyReservationsData();

    await fs.writeFile(
      RESERVATIONS_FILE,
      JSON.stringify(emptyData, null, 2),
      "utf8",
    );

    return [];
  }

  try {
    const data = JSON.parse(content);

    /**
     * Новый формат:
     *
     * {
     *   bishkek: [],
     *   dordoy: [],
     *   osh: []
     * }
     */
    if (isBranchReservationsFormat(data)) {
      let changed = false;

      for (const branch of BRANCHES) {
        if (!Array.isArray(data[branch])) {
          data[branch] = [];
          changed = true;
        }
      }

      if (changed) {
        await fs.writeFile(
          RESERVATIONS_FILE,
          JSON.stringify(data, null, 2),
          "utf8",
        );
      }

      return data[branchKey];
    }

    /**
     * Старый формат:
     *
     * [
     *   {...},
     *   {...}
     * ]
     *
     * Переносим старые данные
     * в текущий филиал.
     */
    if (Array.isArray(data)) {
      const migrated = createEmptyReservationsData();

      migrated[branchKey] = data;

      await fs.writeFile(
        RESERVATIONS_FILE,
        JSON.stringify(migrated, null, 2),
        "utf8",
      );

      return migrated[branchKey];
    }

    /**
     * Если формат неизвестный,
     * создаём чистое хранилище.
     */
    const emptyData = createEmptyReservationsData();

    await fs.writeFile(
      RESERVATIONS_FILE,
      JSON.stringify(emptyData, null, 2),
      "utf8",
    );

    return [];
  } catch (error) {
    console.error("Ошибка JSON reservations.json:", error);

    throw new Error("Не удалось прочитать reservations.json");
  }
}

async function writeReservations(reservations) {
  await ensureStorage();

  const branchKey = getBranchKey();

  let allReservations;

  try {
    const content = await fs.readFile(RESERVATIONS_FILE, "utf8");

    allReservations = content.trim() ? JSON.parse(content) : null;
  } catch {
    allReservations = null;
  }

  if (!isBranchReservationsFormat(allReservations)) {
    allReservations = createEmptyReservationsData();
  }

  for (const branch of BRANCHES) {
    if (!Array.isArray(allReservations[branch])) {
      allReservations[branch] = [];
    }
  }

  allReservations[branchKey] = Array.isArray(reservations) ? reservations : [];

  await fs.writeFile(
    RESERVATIONS_FILE,
    JSON.stringify(allReservations, null, 2),
    "utf8",
  );
}

/**
 * ==========================================
 * CASH STORAGE
 * ==========================================
 */

function createEmptyCashData() {
  return {
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

function isBranchCashFormat(data) {
  return (
    data &&
    typeof data === "object" &&
    !Array.isArray(data) &&
    (Object.prototype.hasOwnProperty.call(data, "bishkek") ||
      Object.prototype.hasOwnProperty.call(data, "dordoy") ||
      Object.prototype.hasOwnProperty.call(data, "osh"))
  );
}

async function addReservationCashTransaction({
  amount,
  reservationId,
  customerName,
  type = "reservation",
}) {
  const normalizedAmount = roundMoney(amount);

  if (!normalizedAmount) {
    return null;
  }

  await fs.mkdir(DATA_DIR, {
    recursive: true,
  });

  const branchKey = getBranchKey();

  let allCash;

  try {
    const content = await fs.readFile(CASH_FILE, "utf8");

    allCash = content.trim() ? JSON.parse(content) : null;
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }

    allCash = null;
  }

  /**
   * Если старый формат:
   *
   * {
   *   balance: 1000,
   *   transactions: []
   * }
   *
   * переносим его в текущий филиал.
   */
  if (!isBranchCashFormat(allCash)) {
    const oldCash = allCash;

    allCash = createEmptyCashData();

    if (oldCash && typeof oldCash === "object" && !Array.isArray(oldCash)) {
      allCash[branchKey] = {
        balance: Number.isFinite(Number(oldCash.balance))
          ? Number(oldCash.balance)
          : 0,

        transactions: Array.isArray(oldCash.transactions)
          ? oldCash.transactions
          : [],
      };
    }
  }

  /**
   * Гарантируем наличие всех филиалов.
   */
  for (const branch of BRANCHES) {
    if (
      !allCash[branch] ||
      typeof allCash[branch] !== "object" ||
      Array.isArray(allCash[branch])
    ) {
      allCash[branch] = {
        balance: 0,
        transactions: [],
      };
    }

    if (!Array.isArray(allCash[branch].transactions)) {
      allCash[branch].transactions = [];
    }

    if (!Number.isFinite(Number(allCash[branch].balance))) {
      allCash[branch].balance = 0;
    }

    allCash[branch].balance = Number(allCash[branch].balance);
  }

  const cashData = allCash[branchKey];

  const balanceBefore = roundMoney(toNumber(cashData.balance));

  const balanceAfter = roundMoney(balanceBefore + normalizedAmount);

  const transaction = {
    id: createId("cash-reservation"),

    type,

    amount: normalizedAmount,

    balanceBefore,

    balanceAfter,

    reservationId: reservationId || null,

    customerName: customerName || "",

    comment:
      normalizedAmount > 0
        ? "Наличная оплата бронирования"
        : "Возврат оплаты бронирования",

    createdAt: getNow(),
  };

  cashData.balance = balanceAfter;

  cashData.transactions.push(transaction);

  allCash[branchKey] = cashData;

  await fs.writeFile(CASH_FILE, JSON.stringify(allCash, null, 2), "utf8");

  return transaction;
}

/**
 * ==========================================
 * ОБЩИЕ ФУНКЦИИ
 * ==========================================
 */

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function toNumber(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return 0;
  }

  return number;
}

function createId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function getNow() {
  return new Date().toISOString();
}

function normalizePayments(payments = {}) {
  const result = {
    cash: 0,
    card: 0,
    amanat: 0,
    mplus: 0,
    online_qr: 0,
  };

  for (const key of PAYMENT_KEYS) {
    const value = toNumber(payments[key]);

    result[key] = value > 0 ? roundMoney(value) : 0;
  }

  return result;
}

function calculatePaymentTotal(payments = {}) {
  return roundMoney(
    PAYMENT_KEYS.reduce((total, key) => {
      return total + toNumber(payments[key]);
    }, 0),
  );
}

function calculateItemsTotal(items = []) {
  if (!Array.isArray(items)) {
    return 0;
  }

  return roundMoney(
    items.reduce((total, item) => {
      const price = toNumber(item?.price);

      const quantity = toNumber(item?.quantity);

      if (price <= 0 || quantity <= 0) {
        return total;
      }

      return total + price * quantity;
    }, 0),
  );
}

function calculatePaymentHistoryTotal(paymentHistory = []) {
  if (!Array.isArray(paymentHistory)) {
    return 0;
  }

  let total = 0;

  for (const payment of paymentHistory) {
    const type = payment?.type;

    if (type !== "deposit" && type !== "final" && type !== "refund") {
      continue;
    }

    const amount = calculatePaymentTotal(payment);

    if (type === "refund") {
      total -= amount;
    } else {
      total += amount;
    }
  }

  return roundMoney(total);
}

/**
 * ==========================================
 * МОЙСКЛАД
 * ==========================================
 */

/**
 * Запрос к API МойСклад
 */
async function moySkladRequest(endpoint, options = {}) {
  const url = endpoint.startsWith("http")
    ? endpoint
    : `${MOYSKLAD_API}${endpoint}`;

  const auth = Buffer.from(`${LOGIN}:${PASSWORD}`).toString("base64");

  const response = await fetch(url, {
    ...options,

    headers: {
      Accept: "application/json;charset=utf-8",

      Authorization: `Basic ${auth}`,

      ...(options.headers || {}),
    },
  });

  const text = await response.text();

  let data;

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {
      message: text,
    };
  }

  if (!response.ok) {
    console.error("МойСклад API error:", response.status, data);

    throw new Error(
      data?.errors?.[0]?.error ||
        data?.message ||
        `Ошибка МойСклад API: ${response.status}`,
    );
  }

  return data;
}

/**
 * Получаем организацию МойСклад
 */
async function getMoySkladOrganization() {
  const data = await moySkladRequest("/entity/organization?limit=1");

  const organization = data.rows?.[0];

  if (!organization) {
    throw new Error("В МойСклад не найдена организация");
  }

  return organization;
}

/**
 * ==========================================
 * СОЗДАНИЕ РОЗНИЧНОЙ ПРОДАЖИ
 * ==========================================
 */

async function createReservationRetailSale({ reservation, retailShiftSyncId }) {
  if (!retailShiftSyncId) {
    throw new Error("Открытая кассовая смена МойСклад не найдена");
  }

  const retailStoreId = RETAIL_STORE_ID;

  if (!retailStoreId) {
    throw new Error("MOYSKLAD_RETAIL_STORE_ID не указан в .env");
  }

  const organization = await getMoySkladOrganization();

  if (!AGENT) {
    throw new Error("MOYSKLAD_AGENT не указан в .env");
  }

  const payments = normalizePayments(reservation.payments);

  const total = roundMoney(reservation.total);

  const normalizedTotal = Math.round(total * 100);

  const cashSum = Math.round(payments.cash * 100);

  const noCashSum = Math.round(
    (payments.card + payments.amanat + payments.mplus + payments.online_qr) *
      100,
  );

  const paidTotal = cashSum + noCashSum;

  if (paidTotal !== normalizedTotal) {
    throw new Error(
      `Ошибка оплаты брони. Сумма оплаты ${paidTotal / 100} сом, сумма брони ${normalizedTotal / 100} сом`,
    );
  }

  const shiftFilter = encodeURIComponent(`syncId=${retailShiftSyncId}`);

  const shiftData = await moySkladRequest(
    `/entity/retailshift?filter=${shiftFilter}&limit=1`,
  );

  const retailShift = shiftData.rows?.[0];

  if (!retailShift) {
    throw new Error(`Розничная смена с syncId ${retailShiftSyncId} не найдена`);
  }

  const positions = reservation.items.map((item) => {
    if (!item.id) {
      throw new Error(`У товара "${item.name}" отсутствует ID МойСклад`);
    }

    const quantity = Number(item.quantity);

    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new Error(`Некорректное количество товара "${item.name}"`);
    }

    const price = Math.round(Number(item.price) * 100);

    if (!Number.isFinite(price) || price < 0) {
      throw new Error(`Некорректная цена товара "${item.name}"`);
    }

    const type = item.type || "product";

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

  const orderId = `RES-${reservation.id}`;

  const paymentComment = [
    `Бронь: ${reservation.id}`,
    `Клиент: ${reservation.customerName || "Не указан"}`,
    `Телефон: ${reservation.customerPhone || "Не указан"}`,
    `Наличные: ${(cashSum / 100).toFixed(2)} сом`,
    `Карта: ${payments.card.toFixed(2)} сом`,
    `Аманат: ${payments.amanat.toFixed(2)} сом`,
    `М+: ${payments.mplus.toFixed(2)} сом`,
    `Онлайн QR: ${payments.online_qr.toFixed(2)} сом`,
    `Итого: ${(normalizedTotal / 100).toFixed(2)} сом`,
  ].join("\n");

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

  if (cashSum > 0) {
    retailDemandData.cashSum = cashSum;
  }

  if (noCashSum > 0) {
    retailDemandData.noCashSum = noCashSum;
  }

  console.log(
    "Создание розничной продажи по брони:",
    JSON.stringify(retailDemandData, null, 2),
  );

  const retailDemand = await moySkladRequest("/entity/retaildemand", {
    method: "POST",

    headers: {
      "Content-Type": "application/json",
    },

    body: JSON.stringify(retailDemandData),
  });

  return {
    retailDemand,
    retailShift,
    orderId,
    cashSum,
    noCashSum,
  };
}

/**
 * ==========================================
 * PAYMENTS
 * ==========================================
 */

function getPaymentHistoryPaid(paymentHistory = []) {
  if (!Array.isArray(paymentHistory)) {
    return 0;
  }

  let total = 0;

  for (const payment of paymentHistory) {
    if (payment?.type !== "deposit" && payment?.type !== "final") {
      continue;
    }

    total += calculatePaymentTotal(payment);
  }

  for (const payment of paymentHistory) {
    if (payment?.type !== "refund") {
      continue;
    }

    total -= calculatePaymentTotal(payment);
  }

  return Math.max(0, roundMoney(total));
}

function getPaymentCount(paymentHistory = []) {
  if (!Array.isArray(paymentHistory)) {
    return 0;
  }

  return paymentHistory.filter(
    (payment) => payment?.type === "deposit" || payment?.type === "final",
  ).length;
}

function getPaymentStatus(total, paid) {
  const normalizedTotal = roundMoney(total);

  const normalizedPaid = roundMoney(paid);

  if (normalizedPaid <= 0) {
    return "unpaid";
  }

  if (normalizedPaid >= normalizedTotal) {
    return "paid";
  }

  return "partially_paid";
}

function buildPaymentHistoryEntry(type, payments) {
  const normalized = normalizePayments(payments);

  return {
    id: createId("payment"),

    type,

    createdAt: getNow(),

    cash: normalized.cash,

    card: normalized.card,

    amanat: normalized.amanat,

    mplus: normalized.mplus,

    online_qr: normalized.online_qr,
  };
}

/**
 * Для старых броней, где
 * paymentHistory ещё отсутствует.
 */
function ensurePaymentHistory(reservation) {
  if (Array.isArray(reservation.paymentHistory)) {
    return reservation.paymentHistory;
  }

  const payments = normalizePayments(reservation.payments);

  const paid = calculatePaymentTotal(payments);

  if (paid <= 0) {
    return [];
  }

  const createdAt = reservation.createdAt || getNow();

  const history = [
    {
      id: createId("payment"),

      type: "deposit",

      createdAt,

      cash: payments.cash,

      card: payments.card,

      amanat: payments.amanat,

      mplus: payments.mplus,

      online_qr: payments.online_qr,
    },
  ];

  if (reservation.status === "cancelled") {
    history.push({
      id: createId("payment"),

      type: "refund",

      createdAt: reservation.updatedAt || getNow(),

      cash: payments.cash,

      card: payments.card,

      amanat: payments.amanat,

      mplus: payments.mplus,

      online_qr: payments.online_qr,
    });
  }

  return history;
}

function normalizeReservation(reservation) {
  const total = roundMoney(toNumber(reservation.total));

  const payments = normalizePayments(reservation.payments);

  const paymentHistory = ensurePaymentHistory(reservation);

  const paid = getPaymentHistoryPaid(paymentHistory);

  const remaining = Math.max(0, roundMoney(total - paid));

  return {
    ...reservation,

    total,

    payments,

    paid,

    remaining,

    paymentStatus: getPaymentStatus(total, paid),

    paymentHistory,
  };
}

/**
 * ==========================================
 * POST /api/reservations
 *
 * Создание новой брони
 * ==========================================
 */

router.post("/", async (req, res) => {
  try {
    const {
      customerName,
      customerPhone,
      reservationDate,
      items,
      paymentMethod,
      payments,
      comment,
    } = req.body;

    if (typeof customerName !== "string" || !customerName.trim()) {
      return res.status(400).json({
        success: false,
        message: "Введите имя клиента",
      });
    }

    if (typeof customerPhone !== "string" || !customerPhone.trim()) {
      return res.status(400).json({
        success: false,
        message: "Введите телефон клиента",
      });
    }

    if (typeof reservationDate !== "string" || !reservationDate) {
      return res.status(400).json({
        success: false,
        message: "Выберите дату брони",
      });
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Добавьте хотя бы один товар",
      });
    }

    const total = calculateItemsTotal(items);

    if (total <= 0) {
      return res.status(400).json({
        success: false,
        message: "Сумма брони должна быть больше нуля",
      });
    }

    const normalizedPayments = normalizePayments(payments);

    const paymentTotal = calculatePaymentTotal(normalizedPayments);

    if (paymentTotal > total) {
      return res.status(400).json({
        success: false,
        message: "Сумма оплаты не может быть больше суммы брони",
      });
    }

    const now = getNow();

    const paymentHistory = [];

    if (paymentTotal > 0) {
      paymentHistory.push(
        buildPaymentHistoryEntry("deposit", normalizedPayments),
      );
    }

    const paid = paymentTotal;

    const remaining = roundMoney(Math.max(0, total - paid));

    const reservation = {
      id: createId("reservation"),

      customerName: customerName.trim(),

      customerPhone: customerPhone.trim(),

      reservationDate,

      items,

      paymentMethod: paymentMethod || "cash",

      comment: typeof comment === "string" ? comment.trim() : "",

      status: "reserved",

      createdAt: now,

      updatedAt: now,

      total,

      payments: normalizedPayments,

      paid,

      remaining,

      paymentStatus: getPaymentStatus(total, paid),

      paymentHistory,
    };

    const reservations = await readReservations();

    reservations.push(reservation);

    await writeReservations(reservations);

    /**
     * Только наличные
     * идут в cash.json
     */
    if (normalizedPayments.cash > 0) {
      await addReservationCashTransaction({
        amount: normalizedPayments.cash,

        reservationId: reservation.id,

        customerName: reservation.customerName,

        type: "reservation",
      });
    }

    return res.status(201).json({
      success: true,
      reservation,
    });
  } catch (error) {
    console.error("Ошибка создания брони:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Не удалось создать бронь",
    });
  }
});

/**
 * ==========================================
 * GET /api/reservations
 * ==========================================
 */

router.get("/", async (req, res) => {
  try {
    const reservations = await readReservations();

    const normalized = reservations.map(normalizeReservation);

    return res.json({
      success: true,
      reservations: normalized,
    });
  } catch (error) {
    console.error("Ошибка получения броней:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Не удалось получить брони",
    });
  }
});

/**
 * ==========================================
 * PATCH /api/reservations/:id
 * ==========================================
 */

router.patch("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const {
      customerName,
      customerPhone,
      reservationDate,
      items,
      paymentMethod,
      comment,
    } = req.body;

    const reservations = await readReservations();

    const index = reservations.findIndex(
      (reservation) => reservation.id === id,
    );

    if (index === -1) {
      return res.status(404).json({
        success: false,
        message: "Бронь не найдена",
      });
    }

    const current = normalizeReservation(reservations[index]);

    if (current.status === "cancelled") {
      return res.status(400).json({
        success: false,
        message: "Нельзя изменить отменённую бронь",
      });
    }

    if (current.status === "issued") {
      return res.status(400).json({
        success: false,
        message: "Нельзя изменить выданную бронь",
      });
    }

    if (typeof customerName !== "string" || !customerName.trim()) {
      return res.status(400).json({
        success: false,
        message: "Введите имя клиента",
      });
    }

    if (typeof customerPhone !== "string" || !customerPhone.trim()) {
      return res.status(400).json({
        success: false,
        message: "Введите телефон клиента",
      });
    }

    if (typeof reservationDate !== "string" || !reservationDate) {
      return res.status(400).json({
        success: false,
        message: "Выберите дату брони",
      });
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Добавьте хотя бы один товар",
      });
    }

    const newTotal = calculateItemsTotal(items);

    if (newTotal <= 0) {
      return res.status(400).json({
        success: false,
        message: "Сумма брони должна быть больше нуля",
      });
    }

    const paymentHistory = [...ensurePaymentHistory(current)];

    const oldPaid = getPaymentHistoryPaid(paymentHistory);

    const overpayment = roundMoney(Math.max(0, oldPaid - newTotal));

    if (overpayment > 0) {
      paymentHistory.push(
        buildPaymentHistoryEntry("refund", {
          cash: overpayment,

          card: 0,
          amanat: 0,
          mplus: 0,
          online_qr: 0,
        }),
      );
    }

    const newPaid = Math.max(0, roundMoney(oldPaid - overpayment));

    const newRemaining = Math.max(0, roundMoney(newTotal - newPaid));

    const newPayments = normalizePayments(current.payments);

    if (overpayment > 0) {
      newPayments.cash = Math.max(
        0,
        roundMoney(newPayments.cash - overpayment),
      );
    }

    const updatedAt = getNow();

    const updatedReservation = {
      ...current,

      customerName: customerName.trim(),

      customerPhone: customerPhone.trim(),

      reservationDate,

      items,

      paymentMethod: paymentMethod || current.paymentMethod || "cash",

      comment: typeof comment === "string" ? comment.trim() : "",

      total: newTotal,

      payments: newPayments,

      paid: newPaid,

      remaining: newRemaining,

      paymentStatus: getPaymentStatus(newTotal, newPaid),

      paymentHistory,

      updatedAt,
    };

    reservations[index] = updatedReservation;

    await writeReservations(reservations);

    if (overpayment > 0) {
      await addReservationCashTransaction({
        amount: -overpayment,

        reservationId: updatedReservation.id,

        customerName: updatedReservation.customerName,

        type: "reservation",
      });
    }

    return res.json({
      success: true,

      reservation: updatedReservation,

      refund: overpayment,

      refundPayment:
        overpayment > 0
          ? {
              type: "refund",
              cash: overpayment,
              card: 0,
              amanat: 0,
              mplus: 0,
              online_qr: 0,
            }
          : null,
    });
  } catch (error) {
    console.error("Ошибка изменения брони:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Не удалось изменить бронь",
    });
  }
});

/**
 * ==========================================
 * POST /api/reservations/:id/payment
 *
 * Второй и последний платёж
 * ==========================================
 */

router.post("/:id/payment", async (req, res) => {
  try {
    const { id } = req.params;

    const { paymentMethod, payments, paymentType } = req.body;

    const reservations = await readReservations();

    const index = reservations.findIndex(
      (reservation) => reservation.id === id,
    );

    if (index === -1) {
      return res.status(404).json({
        success: false,
        message: "Бронь не найдена",
      });
    }

    const current = normalizeReservation(reservations[index]);

    if (current.status === "cancelled") {
      return res.status(400).json({
        success: false,
        message: "Нельзя внести оплату по отменённой брони",
      });
    }

    if (current.status === "issued") {
      return res.status(400).json({
        success: false,
        message: "Бронь уже выдана",
      });
    }

    if (current.remaining <= 0) {
      return res.status(400).json({
        success: false,
        message: "По этой брони уже нет остатка",
      });
    }

    const paymentHistory = [...ensurePaymentHistory(current)];

    const paymentCount = getPaymentCount(paymentHistory);

    if (paymentCount >= 2) {
      return res.status(400).json({
        success: false,
        message: "По брони уже было максимально два платежа",
      });
    }

    const normalizedPayments = normalizePayments(payments);

    const paymentTotal = calculatePaymentTotal(normalizedPayments);

    if (paymentTotal <= 0) {
      return res.status(400).json({
        success: false,
        message: "Введите сумму оплаты",
      });
    }

    if (paymentTotal !== roundMoney(current.remaining)) {
      return res.status(400).json({
        success: false,
        message: `Второй платёж должен полностью закрыть остаток: ${current.remaining} сом`,
      });
    }

    const type =
      paymentType === "final"
        ? "final"
        : paymentCount === 0
          ? "deposit"
          : "final";

    paymentHistory.push(buildPaymentHistoryEntry(type, normalizedPayments));

    const newPayments = normalizePayments(current.payments);

    for (const key of PAYMENT_KEYS) {
      newPayments[key] = roundMoney(newPayments[key] + normalizedPayments[key]);
    }

    const newPaid = roundMoney(current.paid + paymentTotal);

    const newRemaining = Math.max(0, roundMoney(current.total - newPaid));

    const updatedReservation = {
      ...current,

      payments: newPayments,

      paid: newPaid,

      remaining: newRemaining,

      paymentStatus: getPaymentStatus(current.total, newPaid),

      paymentHistory,

      paymentMethod: paymentMethod || current.paymentMethod || "cash",

      updatedAt: getNow(),
    };

    reservations[index] = updatedReservation;

    await writeReservations(reservations);

    /**
     * Только cash увеличивает
     * cash.json текущего филиала.
     */
    if (normalizedPayments.cash > 0) {
      await addReservationCashTransaction({
        amount: normalizedPayments.cash,

        reservationId: updatedReservation.id,

        customerName: updatedReservation.customerName,

        type: "reservation",
      });
    }

    return res.json({
      success: true,

      reservation: updatedReservation,
    });
  } catch (error) {
    console.error("Ошибка внесения оплаты:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Не удалось внести оплату",
    });
  }
});

/**
 * ==========================================
 * POST /api/reservations/:id/cancel
 * ==========================================
 */

router.post("/:id/cancel", async (req, res) => {
  try {
    const { id } = req.params;

    const reservations = await readReservations();

    const index = reservations.findIndex(
      (reservation) => reservation.id === id,
    );

    if (index === -1) {
      return res.status(404).json({
        success: false,
        message: "Бронь не найдена",
      });
    }

    const current = normalizeReservation(reservations[index]);

    if (current.status === "cancelled") {
      return res.status(400).json({
        success: false,
        message: "Бронь уже отменена",
      });
    }

    if (current.status === "issued") {
      return res.status(400).json({
        success: false,
        message: "Нельзя отменить выданную бронь",
      });
    }

    const paymentHistory = [...ensurePaymentHistory(current)];

    const refundPayments = normalizePayments(current.payments);

    const refundTotal = calculatePaymentTotal(refundPayments);

    if (refundTotal > 0) {
      paymentHistory.push(buildPaymentHistoryEntry("refund", refundPayments));
    }

    const updatedReservation = {
      ...current,

      status: "cancelled",

      updatedAt: getNow(),

      paymentHistory,

      paid: current.paid,

      remaining: current.remaining,
    };

    reservations[index] = updatedReservation;

    await writeReservations(reservations);

    /**
     * При отмене возвращаем
     * только наличную часть
     * в cash.json текущего филиала.
     */
    if (refundPayments.cash > 0) {
      await addReservationCashTransaction({
        amount: -refundPayments.cash,

        reservationId: updatedReservation.id,

        customerName: updatedReservation.customerName,

        type: "reservation",
      });
    }

    return res.json({
      success: true,

      reservation: updatedReservation,

      refund: refundTotal,
    });
  } catch (error) {
    console.error("Ошибка отмены брони:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Не удалось отменить бронь",
    });
  }
});

/**
 * ==========================================
 * POST /api/reservations/:id/issue
 * ==========================================
 */

router.post("/:id/issue", async (req, res) => {
  try {
    const { id } = req.params;

    const { retailShiftSyncId } = req.body;

    const reservations = await readReservations();

    const index = reservations.findIndex(
      (reservation) => reservation.id === id,
    );

    if (index === -1) {
      return res.status(404).json({
        success: false,
        message: "Бронь не найдена",
      });
    }

    const current = normalizeReservation(reservations[index]);

    if (current.status === "cancelled") {
      return res.status(400).json({
        success: false,
        message: "Нельзя выдать отменённую бронь",
      });
    }

    if (current.status === "issued") {
      return res.status(400).json({
        success: false,
        message: "Бронь уже выдана",
      });
    }

    if (current.remaining > 0) {
      return res.status(400).json({
        success: false,
        message: `Нельзя выдать бронь. Остаток: ${current.remaining} сом`,
      });
    }

    if (!retailShiftSyncId) {
      return res.status(400).json({
        success: false,
        message: "Открытая кассовая смена МойСклад не найдена",
      });
    }

    /**
     * =========================================
     * СОЗДАЁМ РОЗНИЧНУЮ ПРОДАЖУ В МОЙСКЛАД
     * =========================================
     */

    let moyskladResult;

    try {
      moyskladResult = await createReservationRetailSale({
        reservation: current,

        retailShiftSyncId,
      });
    } catch (moyskladError) {
      console.error("Ошибка создания продажи брони в МойСклад:", moyskladError);

      return res.status(500).json({
        success: false,
        message:
          moyskladError.message || "Не удалось создать продажу в МойСклад",
      });
    }

    /**
     * =========================================
     * ТОЛЬКО ПОСЛЕ УСПЕШНОГО МОЙСКЛАД
     * ПОМЕЧАЕМ БРОНЬ КАК ВЫДАННУЮ
     * =========================================
     */

    const updatedReservation = {
      ...current,

      status: "issued",

      updatedAt: getNow(),

      moyskladSale: {
        id: moyskladResult.retailDemand?.id || null,

        href: moyskladResult.retailDemand?.meta?.href || null,

        name: moyskladResult.retailDemand?.name || moyskladResult.orderId,

        retailShiftSyncId,

        retailShiftId: moyskladResult.retailShift?.id || null,

        createdAt: getNow(),
      },
    };

    reservations[index] = updatedReservation;

    await writeReservations(reservations);

    return res.json({
      success: true,

      reservation: updatedReservation,

      moysklad: {
        saleId: moyskladResult.retailDemand?.id || null,

        saleHref: moyskladResult.retailDemand?.meta?.href || null,

        retailShiftId: moyskladResult.retailShift?.id || null,
      },
    });
  } catch (error) {
    console.error("Ошибка выдачи брони:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Не удалось выдать бронь",
    });
  }
});

module.exports = router;
