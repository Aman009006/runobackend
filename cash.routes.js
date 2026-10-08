const express = require("express");
const fs = require("fs");
const path = require("path");

const router = express.Router();

const { getCurrentBranch } = require("./branchContext");

/*
|--------------------------------------------------------------------------
| НАСТРОЙКИ
|--------------------------------------------------------------------------
*/

const DATA_DIR = path.join(__dirname, "..", "data");

const CASH_FILE = path.join(DATA_DIR, "cash.json");

/*
|--------------------------------------------------------------------------
| ФИЛИАЛЫ
|--------------------------------------------------------------------------
*/

const BRANCHES = ["bishkek", "dordoy", "osh"];

function getBranchKey() {
  const branch = getCurrentBranch();

  if (!branch?.id) {
    throw new Error("Текущий филиал не определён");
  }

  const branchKey = String(branch.id).trim().toLowerCase();

  if (!BRANCHES.includes(branchKey)) {
    throw new Error(
      `Неизвестный филиал: ${branchKey}. ` +
        `Ожидался: bishkek, dordoy или osh`,
    );
  }

  return branchKey;
}

/*
|--------------------------------------------------------------------------
| СОЗДАНИЕ DATA
|--------------------------------------------------------------------------
*/

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, {
    recursive: true,
  });
}

/*
|--------------------------------------------------------------------------
| НАЧАЛЬНАЯ СТРУКТУРА КАССЫ
|--------------------------------------------------------------------------
*/

function getDefaultCashData() {
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

function getDefaultBranchCash() {
  return {
    balance: 0,
    transactions: [],
  };
}

/*
|--------------------------------------------------------------------------
| СОЗДАНИЕ cash.json
|--------------------------------------------------------------------------
*/

if (!fs.existsSync(CASH_FILE)) {
  fs.writeFileSync(
    CASH_FILE,
    JSON.stringify(getDefaultCashData(), null, 2),
    "utf8",
  );
}

/*
|--------------------------------------------------------------------------
| ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
|--------------------------------------------------------------------------
*/

function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

/*
|--------------------------------------------------------------------------
| НОРМАЛИЗАЦИЯ СТРУКТУРЫ
|--------------------------------------------------------------------------
*/

function normalizeCashData(data) {
  /*
  |--------------------------------------------------------------------------
  | Уже новый филиальный формат
  |--------------------------------------------------------------------------
  */

  if (
    data &&
    typeof data === "object" &&
    !Array.isArray(data) &&
    (Object.prototype.hasOwnProperty.call(data, "bishkek") ||
      Object.prototype.hasOwnProperty.call(data, "dordoy") ||
      Object.prototype.hasOwnProperty.call(data, "osh"))
  ) {
    const result = {
      bishkek:
        data.bishkek &&
        typeof data.bishkek === "object" &&
        !Array.isArray(data.bishkek)
          ? {
              balance: roundMoney(data.bishkek.balance),

              transactions: Array.isArray(data.bishkek.transactions)
                ? data.bishkek.transactions
                : [],
            }
          : getDefaultBranchCash(),

      dordoy:
        data.dordoy &&
        typeof data.dordoy === "object" &&
        !Array.isArray(data.dordoy)
          ? {
              balance: roundMoney(data.dordoy.balance),

              transactions: Array.isArray(data.dordoy.transactions)
                ? data.dordoy.transactions
                : [],
            }
          : getDefaultBranchCash(),

      osh:
        data.osh && typeof data.osh === "object" && !Array.isArray(data.osh)
          ? {
              balance: roundMoney(data.osh.balance),

              transactions: Array.isArray(data.osh.transactions)
                ? data.osh.transactions
                : [],
            }
          : getDefaultBranchCash(),
    };

    return result;
  }

  /*
  |--------------------------------------------------------------------------
  | СТАРЫЙ ФОРМАТ
  |--------------------------------------------------------------------------
  |
  | Если раньше cash.json был:
  |
  | {
  |   "balance": 5000,
  |   "transactions": []
  | }
  |
  | переносим его в текущий филиал.
  |--------------------------------------------------------------------------
  */

  if (
    data &&
    typeof data === "object" &&
    !Array.isArray(data) &&
    (Object.prototype.hasOwnProperty.call(data, "balance") ||
      Object.prototype.hasOwnProperty.call(data, "transactions"))
  ) {
    return {
      bishkek: getDefaultBranchCash(),
      dordoy: getDefaultBranchCash(),
      osh: getDefaultBranchCash(),
    };
  }

  /*
  |--------------------------------------------------------------------------
  | Пустой / неправильный файл
  |--------------------------------------------------------------------------
  */

  return getDefaultCashData();
}

/*
|--------------------------------------------------------------------------
| READ CASH
|--------------------------------------------------------------------------
*/

function readCash() {
  try {
    if (!fs.existsSync(CASH_FILE)) {
      const defaultData = getDefaultCashData();

      fs.writeFileSync(CASH_FILE, JSON.stringify(defaultData, null, 2), "utf8");

      return defaultData;
    }

    const content = fs.readFileSync(CASH_FILE, "utf8");

    if (!content.trim()) {
      const defaultData = getDefaultCashData();

      fs.writeFileSync(CASH_FILE, JSON.stringify(defaultData, null, 2), "utf8");

      return defaultData;
    }

    const data = JSON.parse(content);

    const normalized = normalizeCashData(data);

    /*
    |--------------------------------------------------------------------------
    | Если структура была старой,
    | сохраняем новую филиальную структуру.
    |--------------------------------------------------------------------------
    */

    const isNewFormat =
      data &&
      typeof data === "object" &&
      !Array.isArray(data) &&
      (Object.prototype.hasOwnProperty.call(data, "bishkek") ||
        Object.prototype.hasOwnProperty.call(data, "dordoy") ||
        Object.prototype.hasOwnProperty.call(data, "osh"));

    if (!isNewFormat) {
      fs.writeFileSync(CASH_FILE, JSON.stringify(normalized, null, 2), "utf8");
    }

    return normalized;
  } catch (error) {
    console.error("Ошибка чтения cash.json:", error);

    throw new Error("Не удалось прочитать данные кассы");
  }
}

/*
|--------------------------------------------------------------------------
| WRITE CASH
|--------------------------------------------------------------------------
*/

function writeCash(data) {
  try {
    fs.writeFileSync(CASH_FILE, JSON.stringify(data, null, 2), "utf8");
  } catch (error) {
    console.error("Ошибка записи cash.json:", error);

    throw new Error("Не удалось сохранить данные кассы");
  }
}

/*
|--------------------------------------------------------------------------
| GET CURRENT BRANCH CASH
|--------------------------------------------------------------------------
*/

function getCurrentBranchCash(cashData, branchKey) {
  if (
    !cashData[branchKey] ||
    typeof cashData[branchKey] !== "object" ||
    Array.isArray(cashData[branchKey])
  ) {
    cashData[branchKey] = getDefaultBranchCash();
  }

  if (!Array.isArray(cashData[branchKey].transactions)) {
    cashData[branchKey].transactions = [];
  }

  cashData[branchKey].balance = roundMoney(cashData[branchKey].balance);

  return cashData[branchKey];
}

/*
|--------------------------------------------------------------------------
| НОРМАЛИЗАЦИЯ СУММЫ
|--------------------------------------------------------------------------
*/

function normalizeAmount(value) {
  const amount = Number(String(value).replace(",", ".").trim());

  if (!Number.isFinite(amount)) {
    throw new Error("Некорректная сумма");
  }

  if (amount <= 0) {
    throw new Error("Сумма должна быть больше нуля");
  }

  return roundMoney(amount);
}

/*
|--------------------------------------------------------------------------
| НОРМАЛИЗАЦИЯ ОТВЕТСТВЕННОГО
|--------------------------------------------------------------------------
*/

function normalizeResponsible(value) {
  const responsible = typeof value === "string" ? value.trim() : "";

  if (!responsible) {
    throw new Error("Введите имя ответственного");
  }

  return responsible;
}

/*
|--------------------------------------------------------------------------
| GET BALANCE
|--------------------------------------------------------------------------
|
| GET /api/moysklad/cash/balance
|
| Показывает баланс ТОЛЬКО текущего филиала.
|--------------------------------------------------------------------------
*/

router.get("/balance", (req, res) => {
  try {
    const branchKey = getBranchKey();

    const cashData = readCash();

    const branchCash = getCurrentBranchCash(cashData, branchKey);

    /*
      |--------------------------------------------------------------------------
      | На всякий случай сохраняем нормализованную структуру
      |--------------------------------------------------------------------------
      */

    writeCash(cashData);

    return res.json({
      success: true,

      branch: branchKey,

      balance: roundMoney(branchCash.balance),

      currency: "KGS",

      currencyName: "сом",
    });
  } catch (error) {
    console.error("Ошибка получения баланса кассы:", error);

    return res.status(500).json({
      success: false,

      message: error.message || "Не удалось получить баланс кассы",
    });
  }
});

/*
|--------------------------------------------------------------------------
| DEPOSIT — ЗАНЕСЕНИЕ ДЕНЕГ
|--------------------------------------------------------------------------
|
| POST /api/moysklad/cash/deposit
|--------------------------------------------------------------------------
*/

router.post("/deposit", (req, res) => {
  try {
    const branchKey = getBranchKey();

    const { amount, comment, responsible } = req.body;

    const normalizedAmount = normalizeAmount(amount);

    const normalizedResponsible = normalizeResponsible(responsible);

    const cashData = readCash();

    const branchCash = getCurrentBranchCash(cashData, branchKey);

    const oldBalance = roundMoney(branchCash.balance);

    const newBalance = roundMoney(oldBalance + normalizedAmount);

    const transaction = {
      id: `CASH-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,

      type: "deposit",

      amount: normalizedAmount,

      balanceBefore: oldBalance,

      balanceAfter: newBalance,

      responsible: normalizedResponsible,

      comment:
        typeof comment === "string" && comment.trim()
          ? comment.trim()
          : "Занесение денег",

      createdAt: new Date().toISOString(),
    };

    branchCash.balance = newBalance;

    branchCash.transactions.push(transaction);

    writeCash(cashData);

    console.log("================================");

    console.log("ЗАНЕСЕНИЕ ДЕНЕГ");

    console.log("Филиал:", branchKey);

    console.log("Сумма:", normalizedAmount, "сом");

    console.log("Ответственный:", normalizedResponsible);

    console.log("Было:", oldBalance, "сом");

    console.log("Стало:", newBalance, "сом");

    console.log("Transaction:", transaction.id);

    console.log("================================");

    return res.status(201).json({
      success: true,

      branch: branchKey,

      message: "Деньги успешно занесены",

      balance: newBalance,

      transaction,
    });
  } catch (error) {
    console.error("Ошибка занесения денег:", error);

    return res.status(400).json({
      success: false,

      message: error.message || "Не удалось занести деньги",
    });
  }
});

/*
|--------------------------------------------------------------------------
| WITHDRAW — ЗАБОР ДЕНЕГ
|--------------------------------------------------------------------------
|
| POST /api/moysklad/cash/withdraw
|--------------------------------------------------------------------------
*/

router.post("/withdraw", (req, res) => {
  try {
    const branchKey = getBranchKey();

    const { amount, comment, responsible } = req.body;

    const normalizedAmount = normalizeAmount(amount);

    const normalizedResponsible = normalizeResponsible(responsible);

    const cashData = readCash();

    const branchCash = getCurrentBranchCash(cashData, branchKey);

    const oldBalance = roundMoney(branchCash.balance);

    /*
      |--------------------------------------------------------------------------
      | Нельзя забрать больше денег,
      | чем есть в кассе.
      |--------------------------------------------------------------------------
      */

    if (normalizedAmount > oldBalance) {
      return res.status(400).json({
        success: false,

        message:
          `Недостаточно денег в кассе. ` +
          `Доступно: ${oldBalance.toFixed(2)} сом`,
      });
    }

    const newBalance = roundMoney(oldBalance - normalizedAmount);

    const transaction = {
      id: `CASH-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,

      type: "withdraw",

      amount: normalizedAmount,

      balanceBefore: oldBalance,

      balanceAfter: newBalance,

      responsible: normalizedResponsible,

      comment:
        typeof comment === "string" && comment.trim()
          ? comment.trim()
          : "Забор денег",

      createdAt: new Date().toISOString(),
    };

    branchCash.balance = newBalance;

    branchCash.transactions.push(transaction);

    writeCash(cashData);

    console.log("================================");

    console.log("ЗАБОР ДЕНЕГ");

    console.log("Филиал:", branchKey);

    console.log("Сумма:", normalizedAmount, "сом");

    console.log("Ответственный:", normalizedResponsible);

    console.log("Было:", oldBalance, "сом");

    console.log("Стало:", newBalance, "сом");

    console.log("Transaction:", transaction.id);

    console.log("================================");

    return res.status(201).json({
      success: true,

      branch: branchKey,

      message: "Деньги успешно забраны",

      balance: newBalance,

      transaction,
    });
  } catch (error) {
    console.error("Ошибка забора денег:", error);

    return res.status(400).json({
      success: false,

      message: error.message || "Не удалось забрать деньги",
    });
  }
});

/*
|--------------------------------------------------------------------------
| GET TRANSACTIONS — ИСТОРИЯ ОПЕРАЦИЙ
|--------------------------------------------------------------------------
|
| GET /api/moysklad/cash/transactions
|
| Показывает историю ТОЛЬКО текущего филиала.
|--------------------------------------------------------------------------
*/

router.get("/transactions", (req, res) => {
  try {
    const branchKey = getBranchKey();

    const cashData = readCash();

    const branchCash = getCurrentBranchCash(cashData, branchKey);

    const transactions = [...branchCash.transactions].reverse();

    return res.json({
      success: true,

      branch: branchKey,

      balance: roundMoney(branchCash.balance),

      total: transactions.length,

      transactions,
    });
  } catch (error) {
    console.error("Ошибка получения истории кассы:", error);

    return res.status(500).json({
      success: false,

      message: error.message || "Не удалось получить историю транзакций",
    });
  }
});

module.exports = router;
