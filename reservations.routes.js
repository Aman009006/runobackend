const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const router = express.Router();

const DATA_DIR = path.join(__dirname, "..", "data");
const RESERVATIONS_FILE = path.join(DATA_DIR, "reservations.json");
const CASH_FILE = path.join(DATA_DIR, "cash.json");
const PAYMENT_KEYS = ["cash", "card", "amanat", "mplus"];

async function ensureStorage() {
  await fs.mkdir(DATA_DIR, {
    recursive: true,
  });

  try {
    await fs.access(RESERVATIONS_FILE);
  } catch {
    await fs.writeFile(RESERVATIONS_FILE, "[]", "utf8");
  }
}

async function readReservations() {
  await ensureStorage();

  const content = await fs.readFile(RESERVATIONS_FILE, "utf8");

  if (!content.trim()) {
    return [];
  }

  try {
    const data = JSON.parse(content);

    if (!Array.isArray(data)) {
      return [];
    }

    return data;
  } catch (error) {
    console.error("Ошибка JSON reservations.json:", error);

    throw new Error("Не удалось прочитать reservations.json");
  }
}

async function writeReservations(reservations) {
  await ensureStorage();

  await fs.writeFile(
    RESERVATIONS_FILE,
    JSON.stringify(reservations, null, 2),
    "utf8",
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

  let cashData = {
    balance: 0,
    transactions: [],
  };

  try {
    const content = await fs.readFile(CASH_FILE, "utf8");

    if (content.trim()) {
      const parsed = JSON.parse(content);

      if (parsed && typeof parsed === "object") {
        cashData = parsed;
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  if (!Array.isArray(cashData.transactions)) {
    cashData.transactions = [];
  }

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

  await fs.writeFile(CASH_FILE, JSON.stringify(cashData, null, 2), "utf8");

  return transaction;
}

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

    const cash = toNumber(payment?.cash);
    const card = toNumber(payment?.card);
    const amanat = toNumber(payment?.amanat);
    const mplus = toNumber(payment?.mplus);

    const amount = cash + card + amanat + mplus;

    if (type === "refund") {
      total -= amount;
    } else {
      total += amount;
    }
  }

  return roundMoney(total);
}

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
  };
}

/**
 * Для старых броней, где paymentHistory
 * ещё отсутствует.
 *
 * Старую предоплату считаем проведённой
 * в момент создания брони.
 *
 * Если старая бронь уже cancelled,
 * исторически считаем её возвращённой,
 * чтобы она не продолжала увеличивать кассу.
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
 * POST /api/reservations
 *
 * Создание новой брони.
 *
 * Если клиент сразу внёс деньги,
 * это первый платёж — deposit.
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
 * GET /api/reservations
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
 * PATCH /api/reservations/:id
 *
 * Изменение брони.
 *
 * ВАЖНАЯ ЛОГИКА:
 *
 * Было:
 * total = 10000
 * paid = 5000
 *
 * Стало:
 * total = 4000
 *
 * Получаем переплату:
 * 5000 - 4000 = 1000
 *
 * Backend создаёт refund на 1000
 * с текущей датой.
 *
 * То есть:
 *
 * deposit +5000
 * refund  -1000
 *
 * Итог:
 * paid = 4000
 * remaining = 0
 *
 * Для кассы refund уменьшит
 * текущую сумму на 1000 сом.
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

    /**
     * paymentHistory берём из текущей
     * брони, а не из frontend.
     *
     * Это важно, потому что frontend
     * не должен создавать финансовую
     * историю самостоятельно.
     */
    const paymentHistory = [...ensurePaymentHistory(current)];

    /**
     * Сколько реально было оплачено
     * до изменения заказа.
     */
    const oldPaid = getPaymentHistoryPaid(paymentHistory);

    /**
     * Если новый total меньше уже
     * оплаченной суммы, возникает
     * переплата.
     *
     * Пример:
     *
     * oldPaid = 5000
     * newTotal = 4000
     *
     * refund = 1000
     */
    const overpayment = roundMoney(Math.max(0, oldPaid - newTotal));

    if (overpayment > 0) {
      /**
       * В текущей бизнес-логике
       * эта разница возвращается
       * наличными.
       *
       * Поэтому в кассе сегодня
       * будет:
       *
       * -1000 сом
       */
      paymentHistory.push(
        buildPaymentHistoryEntry("refund", {
          cash: overpayment,
          card: 0,
          amanat: 0,
          mplus: 0,
        }),
      );
    }

    /**
     * После возможного возврата
     * рассчитываем новую оплаченную
     * сумму.
     */
    const newPaid = Math.max(0, roundMoney(oldPaid - overpayment));

    const newRemaining = Math.max(0, roundMoney(newTotal - newPaid));

    /**
     * Сохраняем старые payments,
     * но уменьшаем их на возврат.
     *
     * В обычном сценарии возврат
     * наличными относится к cash.
     */
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
 * POST /api/reservations/:id/payment
 *
 * Второй и последний платёж —
 * полный выкуп остатка.
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

    /**
     * Максимум два платежа:
     *
     * 1. deposit
     * 2. final
     */
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

    /**
     * Второй платёж должен закрывать
     * весь оставшийся долг.
     */
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
 * POST /api/reservations/:id/cancel
 *
 * Отмена брони.
 *
 * Если по ней были деньги,
 * создаём refund сегодняшней датой.
 *
 * Это НЕ удаляет старый deposit.
 *
 * В истории будет:
 *
 * deposit +5000
 * refund  -5000
 *
 * Поэтому касса корректно получит
 * чистый финансовый результат.
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

    /**
     * Возвращаем всю фактически
     * оплаченную сумму.
     *
     * Для кассы важна cash-часть.
     */
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

      /**
       * payments оставляем как
       * исторически внесённые суммы.
       *
       * Финансовый результат определяется
       * через paymentHistory.
       */
      paid: current.paid,

      remaining: current.remaining,
    };

    reservations[index] = updatedReservation;

    await writeReservations(reservations);

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
 * POST /api/reservations/:id/issue
 *
 * Выдача брони.
 *
 * Выдавать можно только полностью
 * оплаченную бронь.
 */
router.post("/:id/issue", async (req, res) => {
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

    const updatedReservation = {
      ...current,

      status: "issued",

      updatedAt: getNow(),
    };

    reservations[index] = updatedReservation;

    await writeReservations(reservations);

    return res.json({
      success: true,
      reservation: updatedReservation,
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
