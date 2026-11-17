
const express = require("express");
const { getCurrentBranch } = require("./branchContext");

const router = express.Router();

const states = new Map();

const STATE_TTL = 30 * 1000;

const EMPTY_CART = {
  isOpen: false,
  items: [],
  total: 0,
};

const EMPTY_PAYMENT = {
  status: "idle",
  qrCode: "",
  amount: 0,
  paymentId: "",
};

function getTerminalKey(req) {
  const branch = getCurrentBranch();

  if (!branch?.id) {
    throw new Error("Текущий филиал не определён");
  }

  const terminalId = String(
    req.query.terminalId || req.body?.terminalId || "main"
  ).trim();

  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(terminalId)) {
    throw new Error("Некорректный terminalId");
  }

  return `${String(branch.id).toLowerCase()}:${terminalId}`;
}

function toNumber(value) {
  const number = Number(value);

  return Number.isFinite(number) ? number : 0;
}

function normalizeCart(state = {}) {
  return {
    isOpen: Boolean(state.isOpen),

    items: Array.isArray(state.items)
      ? state.items.slice(0, 100).map((item) => ({
          id: String(item.id || ""),
          name: String(item.name || "Без названия").slice(0, 200),
          price: toNumber(item.price),
          quantity: Math.max(0, toNumber(item.quantity)),
        }))
      : [],

    total: toNumber(state.total),
  };
}

function normalizePayment(state = {}) {
  const allowedStatuses = [
    "idle",
    "pending",
    "success",
    "failed",
  ];

  return {
    status: allowedStatuses.includes(state.status)
      ? state.status
      : "idle",

    qrCode:
      typeof state.qrCode === "string"
        ? state.qrCode.slice(0, 50000)
        : "",

    amount: toNumber(state.amount),

    paymentId: String(state.paymentId || "").slice(0, 200),
  };
}

// Отправка состояния с кассы
router.post("/state", (req, res) => {
  try {
    const key = getTerminalKey(req);
    const { type, state } = req.body || {};

    let current = states.get(key);

    if (!current) {
      current = {
        cart: EMPTY_CART,
        payment: EMPTY_PAYMENT,
      };
    }

    if (type === "cart") {
      current.cart = normalizeCart(state);
    } else if (type === "payment") {
      current.payment = normalizePayment(state);
    } else {
      return res.status(400).json({
        success: false,
        message: "Неизвестный тип обновления",
      });
    }

    current.updatedAt = Date.now();
    current.expiresAt = Date.now() + STATE_TTL;

    states.set(key, current);

    // Удаляем устаревшие состояния
    for (const [storedKey, storedState] of states.entries()) {
      if (storedState.expiresAt < Date.now()) {
        states.delete(storedKey);
      }
    }

    return res.json({
      success: true,
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      message: error.message,
    });
  }
});

// Получение состояния вторым экраном
router.get("/state", (req, res) => {
  try {
    const key = getTerminalKey(req);
    const current = states.get(key);

    res.set("Cache-Control", "no-store");

    if (!current || current.expiresAt < Date.now()) {
      states.delete(key);

      return res.json({
        success: true,
        cart: EMPTY_CART,
        payment: EMPTY_PAYMENT,
      });
    }

    return res.json({
      success: true,
      cart: current.cart,
      payment: current.payment,
      updatedAt: current.updatedAt,
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      message: error.message,
    });
  }
});

module.exports = router;
