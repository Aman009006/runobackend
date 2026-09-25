
const express = require("express");
const fs = require("fs");
const path = require("path");

const router = express.Router();

/*
|--------------------------------------------------------------------------
| НАСТРОЙКИ
|--------------------------------------------------------------------------
*/

const DATA_DIR = path.join(__dirname, "..", "data");

const CASH_FILE = path.join(DATA_DIR, "cash.json");

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
| READ CASH
|--------------------------------------------------------------------------
*/

function readCash() {
  try {
    if (!fs.existsSync(CASH_FILE)) {
      const defaultData = getDefaultCashData();

      fs.writeFileSync(
        CASH_FILE,
        JSON.stringify(defaultData, null, 2),
        "utf8",
      );

      return defaultData;
    }

    const content = fs.readFileSync(
      CASH_FILE,
      "utf8",
    );

    if (!content.trim()) {
      const defaultData = getDefaultCashData();

      fs.writeFileSync(
        CASH_FILE,
        JSON.stringify(defaultData, null, 2),
        "utf8",
      );

      return defaultData;
    }

    const data = JSON.parse(content);

    if (
      !data ||
      typeof data !== "object" ||
      !Number.isFinite(Number(data.balance)) ||
      !Array.isArray(data.transactions)
    ) {
      throw new Error(
        "Некорректная структура cash.json",
      );
    }

    return {
      balance: roundMoney(data.balance),
      transactions: data.transactions,
    };
  } catch (error) {
    console.error(
      "Ошибка чтения cash.json:",
      error,
    );

    throw new Error(
      "Не удалось прочитать данные кассы",
    );
  }
}

/*
|--------------------------------------------------------------------------
| WRITE CASH
|--------------------------------------------------------------------------
*/

function writeCash(data) {
  try {
    fs.writeFileSync(
      CASH_FILE,
      JSON.stringify(data, null, 2),
      "utf8",
    );
  } catch (error) {
    console.error(
      "Ошибка записи cash.json:",
      error,
    );

    throw new Error(
      "Не удалось сохранить данные кассы",
    );
  }
}

/*
|--------------------------------------------------------------------------
| НОРМАЛИЗАЦИЯ СУММЫ
|--------------------------------------------------------------------------
*/

function normalizeAmount(value) {
  const amount = Number(
    String(value)
      .replace(",", ".")
      .trim(),
  );

  if (!Number.isFinite(amount)) {
    throw new Error("Некорректная сумма");
  }

  if (amount <= 0) {
    throw new Error(
      "Сумма должна быть больше нуля",
    );
  }

  return roundMoney(amount);
}

/*
|--------------------------------------------------------------------------
| НОРМАЛИЗАЦИЯ ОТВЕТСТВЕННОГО
|--------------------------------------------------------------------------
*/

function normalizeResponsible(value) {
  const responsible =
    typeof value === "string"
      ? value.trim()
      : "";

  if (!responsible) {
    throw new Error(
      "Введите имя ответственного",
    );
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
| Баланс берётся только из cash.json.
| Продажи, брони и приходы не учитываются.
|--------------------------------------------------------------------------
*/

router.get("/balance", (req, res) => {
  try {
    const cashData = readCash();

    return res.json({
      success: true,

      balance: roundMoney(
        cashData.balance,
      ),

      currency: "KGS",

      currencyName: "сом",
    });
  } catch (error) {
    console.error(
      "Ошибка получения баланса кассы:",
      error,
    );

    return res.status(500).json({
      success: false,

      message:
        error.message ||
        "Не удалось получить баланс кассы",
    });
  }
});

/*
|--------------------------------------------------------------------------
| DEPOSIT — ЗАНЕСЕНИЕ ДЕНЕГ
|--------------------------------------------------------------------------
|
| POST /api/moysklad/cash/deposit
|
| body:
|
| {
|   "amount": 5000,
|   "responsible": "Аман",
|   "comment": "Внесение денег"
| }
|--------------------------------------------------------------------------
*/

router.post("/deposit", (req, res) => {
  try {
    const {
      amount,
      comment,
      responsible,
    } = req.body;

    const normalizedAmount =
      normalizeAmount(amount);

    const normalizedResponsible =
      normalizeResponsible(responsible);

    const cashData = readCash();

    const oldBalance = roundMoney(
      cashData.balance,
    );

    const newBalance = roundMoney(
      oldBalance + normalizedAmount,
    );

    const transaction = {
      id: `CASH-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}`,

      type: "deposit",

      amount: normalizedAmount,

      balanceBefore: oldBalance,

      balanceAfter: newBalance,

      responsible: normalizedResponsible,

      comment:
        typeof comment === "string" &&
        comment.trim()
          ? comment.trim()
          : "Занесение денег",

      createdAt: new Date().toISOString(),
    };

    cashData.balance = newBalance;

    cashData.transactions.push(
      transaction,
    );

    writeCash(cashData);

    console.log(
      "================================",
    );
    console.log("ЗАНЕСЕНИЕ ДЕНЕГ");
    console.log(
      "Сумма:",
      normalizedAmount,
      "сом",
    );
    console.log(
      "Ответственный:",
      normalizedResponsible,
    );
    console.log(
      "Было:",
      oldBalance,
      "сом",
    );
    console.log(
      "Стало:",
      newBalance,
      "сом",
    );
    console.log(
      "Transaction:",
      transaction.id,
    );
    console.log(
      "================================",
    );

    return res.status(201).json({
      success: true,

      message: "Деньги успешно занесены",

      balance: newBalance,

      transaction,
    });
  } catch (error) {
    console.error(
      "Ошибка занесения денег:",
      error,
    );

    return res.status(400).json({
      success: false,

      message:
        error.message ||
        "Не удалось занести деньги",
    });
  }
});

/*
|--------------------------------------------------------------------------
| WITHDRAW — ЗАБОР ДЕНЕГ
|--------------------------------------------------------------------------
|
| POST /api/moysklad/cash/withdraw
|
| body:
|
| {
|   "amount": 3000,
|   "responsible": "Аман",
|   "comment": "Инкассация"
| }
|--------------------------------------------------------------------------
*/

router.post("/withdraw", (req, res) => {
  try {
    const {
      amount,
      comment,
      responsible,
    } = req.body;

    const normalizedAmount =
      normalizeAmount(amount);

    const normalizedResponsible =
      normalizeResponsible(responsible);

    const cashData = readCash();

    const oldBalance = roundMoney(
      cashData.balance,
    );

    /*
     * Нельзя забрать больше денег,
     * чем есть в кассе.
     */

    if (normalizedAmount > oldBalance) {
      return res.status(400).json({
        success: false,

        message:
          `Недостаточно денег в кассе. ` +
          `Доступно: ${oldBalance.toFixed(2)} сом`,
      });
    }

    const newBalance = roundMoney(
      oldBalance - normalizedAmount,
    );

    const transaction = {
      id: `CASH-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}`,

      type: "withdraw",

      amount: normalizedAmount,

      balanceBefore: oldBalance,

      balanceAfter: newBalance,

      responsible: normalizedResponsible,

      comment:
        typeof comment === "string" &&
        comment.trim()
          ? comment.trim()
          : "Забор денег",

      createdAt: new Date().toISOString(),
    };

    cashData.balance = newBalance;

    cashData.transactions.push(
      transaction,
    );

    writeCash(cashData);

    console.log(
      "================================",
    );
    console.log("ЗАБОР ДЕНЕГ");
    console.log(
      "Сумма:",
      normalizedAmount,
      "сом",
    );
    console.log(
      "Ответственный:",
      normalizedResponsible,
    );
    console.log(
      "Было:",
      oldBalance,
      "сом",
    );
    console.log(
      "Стало:",
      newBalance,
      "сом",
    );
    console.log(
      "Transaction:",
      transaction.id,
    );
    console.log(
      "================================",
    );

    return res.status(201).json({
      success: true,

      message: "Деньги успешно забраны",

      balance: newBalance,

      transaction,
    });
  } catch (error) {
    console.error(
      "Ошибка забора денег:",
      error,
    );

    return res.status(400).json({
      success: false,

      message:
        error.message ||
        "Не удалось забрать деньги",
    });
  }
});

/*
|--------------------------------------------------------------------------
| GET TRANSACTIONS — ИСТОРИЯ ОПЕРАЦИЙ
|--------------------------------------------------------------------------
|
| GET /api/moysklad/cash/transactions
|--------------------------------------------------------------------------
*/

router.get("/transactions", (req, res) => {
  try {
    const cashData = readCash();

    /*
     * Новые операции сверху.
     */

    const transactions = [
      ...cashData.transactions,
    ].reverse();

    return res.json({
      success: true,

      balance: roundMoney(
        cashData.balance,
      ),

      total: transactions.length,

      transactions,
    });
  } catch (error) {
    console.error(
      "Ошибка получения истории кассы:",
      error,
    );

    return res.status(500).json({
      success: false,

      message:
        error.message ||
        "Не удалось получить историю транзакций",
    });
  }
});

module.exports = router;