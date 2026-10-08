const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { getCurrentBranch } = require("./branchContext");

const router = express.Router();

const DATA_DIR = path.join(__dirname, "..", "data");
const DATA_FILE = path.join(DATA_DIR, "expenses.json");
const CASH_FILE = path.join(DATA_DIR, "cash.json");

const BRANCHES = ["bishkek", "dordoy", "osh"];

const DEFAULT_CATEGORIES = [
  "Аренда",
  "Зарплата",
  "Транспорт",
  "Коммунальные услуги",
  "Закупка",
  "Другое",
];

/*
 * ==========================================
 * ОБЩИЕ ФУНКЦИИ ФИЛИАЛА
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

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, {
      recursive: true,
    });
  }
}

/*
 * ==========================================
 * EXPENSES
 * ==========================================
 *
 * Новый формат:
 *
 * {
 *   "bishkek": [],
 *   "dordoy": [],
 *   "osh": []
 * }
 *
 * Старый формат:
 *
 * [
 *   {...},
 *   {...}
 * ]
 *
 * При первом чтении старого файла
 * данные автоматически попадут
 * в текущий филиал.
 * ==========================================
 */

function createEmptyExpensesFile() {
  return {
    bishkek: [],
    dordoy: [],
    osh: [],
  };
}

function isBranchExpensesFormat(data) {
  return (
    data &&
    typeof data === "object" &&
    !Array.isArray(data) &&
    (Object.prototype.hasOwnProperty.call(data, "bishkek") ||
      Object.prototype.hasOwnProperty.call(data, "dordoy") ||
      Object.prototype.hasOwnProperty.call(data, "osh"))
  );
}

function ensureDataFile() {
  ensureDataDir();

  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(
      DATA_FILE,
      JSON.stringify(createEmptyExpensesFile(), null, 2),
      "utf8",
    );
  }
}

function readExpenses() {
  ensureDataFile();

  try {
    const data = fs.readFileSync(DATA_FILE, "utf8");

    const branchKey = getBranchKey();

    if (!data.trim()) {
      const emptyData = createEmptyExpensesFile();

      fs.writeFileSync(DATA_FILE, JSON.stringify(emptyData, null, 2), "utf8");

      return [];
    }

    const parsed = JSON.parse(data);

    /*
     * ======================================
     * НОВЫЙ ФОРМАТ
     * ======================================
     */

    if (isBranchExpensesFormat(parsed)) {
      let changed = false;

      /*
       * Гарантируем наличие всех филиалов
       */

      for (const branch of BRANCHES) {
        if (!Array.isArray(parsed[branch])) {
          parsed[branch] = [];
          changed = true;
        }
      }

      if (changed) {
        fs.writeFileSync(DATA_FILE, JSON.stringify(parsed, null, 2), "utf8");
      }

      return parsed[branchKey];
    }

    /*
     * ======================================
     * СТАРЫЙ ФОРМАТ
     *
     * [
     *   {...}
     * ]
     * ======================================
     *
     * Переносим старые расходы
     * в текущий филиал.
     */

    if (Array.isArray(parsed)) {
      const migrated = createEmptyExpensesFile();

      migrated[branchKey] = parsed;

      fs.writeFileSync(DATA_FILE, JSON.stringify(migrated, null, 2), "utf8");

      return migrated[branchKey];
    }

    /*
     * Если файл повреждён
     */

    const emptyData = createEmptyExpensesFile();

    fs.writeFileSync(DATA_FILE, JSON.stringify(emptyData, null, 2), "utf8");

    return [];
  } catch (error) {
    console.error("Ошибка чтения expenses.json:", error);

    return [];
  }
}

function writeExpenses(expenses) {
  ensureDataFile();

  const branchKey = getBranchKey();

  let allExpenses;

  try {
    const data = fs.readFileSync(DATA_FILE, "utf8");

    allExpenses = data.trim() ? JSON.parse(data) : null;
  } catch {
    allExpenses = null;
  }

  /*
   * Если старый формат —
   * создаём новый.
   */

  if (!isBranchExpensesFormat(allExpenses)) {
    allExpenses = createEmptyExpensesFile();
  }

  /*
   * Гарантируем остальные филиалы
   */

  for (const branch of BRANCHES) {
    if (!Array.isArray(allExpenses[branch])) {
      allExpenses[branch] = [];
    }
  }

  /*
   * Записываем только текущий филиал
   */

  allExpenses[branchKey] = Array.isArray(expenses) ? expenses : [];

  fs.writeFileSync(DATA_FILE, JSON.stringify(allExpenses, null, 2), "utf8");
}

/*
 * ==========================================
 * CASH
 * ==========================================
 *
 * Новый формат:
 *
 * {
 *   "bishkek": {
 *     "balance": 0,
 *     "transactions": []
 *   },
 *   "dordoy": {
 *     "balance": 0,
 *     "transactions": []
 *   },
 *   "osh": {
 *     "balance": 0,
 *     "transactions": []
 *   }
 * }
 * ==========================================
 */

function createEmptyCashFile() {
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

function normalizeCash(cash) {
  if (!cash || typeof cash !== "object" || Array.isArray(cash)) {
    return {
      balance: 0,
      transactions: [],
    };
  }

  if (!Array.isArray(cash.transactions)) {
    cash.transactions = [];
  }

  if (!Number.isFinite(Number(cash.balance))) {
    cash.balance = 0;
  }

  cash.balance = Number(cash.balance);

  return cash;
}

function ensureCashFile() {
  ensureDataDir();

  if (!fs.existsSync(CASH_FILE)) {
    fs.writeFileSync(
      CASH_FILE,
      JSON.stringify(createEmptyCashFile(), null, 2),
      "utf8",
    );
  }
}

function readCash() {
  ensureCashFile();

  try {
    const data = fs.readFileSync(CASH_FILE, "utf8");

    const branchKey = getBranchKey();

    /*
     * Пустой файл
     */

    if (!data.trim()) {
      const emptyCash = createEmptyCashFile();

      fs.writeFileSync(CASH_FILE, JSON.stringify(emptyCash, null, 2), "utf8");

      return emptyCash[branchKey];
    }

    const parsed = JSON.parse(data);

    /*
     * ======================================
     * НОВЫЙ ФОРМАТ
     * ======================================
     */

    if (isBranchCashFormat(parsed)) {
      let changed = false;

      for (const branch of BRANCHES) {
        if (
          !parsed[branch] ||
          typeof parsed[branch] !== "object" ||
          Array.isArray(parsed[branch])
        ) {
          parsed[branch] = {
            balance: 0,
            transactions: [],
          };

          changed = true;
        }

        const normalized = normalizeCash(parsed[branch]);

        if (normalized !== parsed[branch]) {
          parsed[branch] = normalized;

          changed = true;
        }
      }

      if (changed) {
        fs.writeFileSync(CASH_FILE, JSON.stringify(parsed, null, 2), "utf8");
      }

      return normalizeCash(parsed[branchKey]);
    }

    /*
     * ======================================
     * СТАРЫЙ ФОРМАТ
     *
     * {
     *   balance: 1000,
     *   transactions: []
     * }
     * ======================================
     */

    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const migrated = createEmptyCashFile();

      migrated[branchKey] = normalizeCash(parsed);

      fs.writeFileSync(CASH_FILE, JSON.stringify(migrated, null, 2), "utf8");

      return migrated[branchKey];
    }

    /*
     * Полностью некорректный файл
     */

    const emptyCash = createEmptyCashFile();

    fs.writeFileSync(CASH_FILE, JSON.stringify(emptyCash, null, 2), "utf8");

    return emptyCash[branchKey];
  } catch (error) {
    console.error("Ошибка чтения cash.json:", error);

    throw new Error("Не удалось прочитать cash.json");
  }
}

function writeCash(cash) {
  ensureCashFile();

  const branchKey = getBranchKey();

  let allCash;

  try {
    const data = fs.readFileSync(CASH_FILE, "utf8");

    allCash = data.trim() ? JSON.parse(data) : null;
  } catch {
    allCash = null;
  }

  /*
   * Если старый формат —
   * создаём новый.
   */

  if (!isBranchCashFormat(allCash)) {
    allCash = createEmptyCashFile();
  }

  /*
   * Гарантируем все филиалы
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

    allCash[branch] = normalizeCash(allCash[branch]);
  }

  /*
   * Записываем только текущий филиал
   */

  allCash[branchKey] = normalizeCash(cash);

  fs.writeFileSync(CASH_FILE, JSON.stringify(allCash, null, 2), "utf8");
}

/*
 * ==========================================
 * СПИСАНИЕ РАСХОДА ИЗ КАССЫ
 * ==========================================
 */

function addExpenseToCash(amount, expense) {
  const expenseAmount = Number(amount);

  if (!Number.isFinite(expenseAmount) || expenseAmount <= 0) {
    throw new Error("Некорректная сумма расхода");
  }

  const cash = readCash();

  const balanceBefore = Number(cash.balance || 0);

  const balanceAfter = balanceBefore - expenseAmount;

  const transaction = {
    id: `CASH-EXPENSE-${Date.now()}-` + crypto.randomUUID().slice(0, 8),

    type: "Rashod",

    amount: -expenseAmount,

    balanceBefore,

    balanceAfter,

    expenseId: expense.id,

    category: expense.category,

    comment: expense.comment || "",

    createdAt: new Date().toISOString(),
  };

  cash.balance = balanceAfter;

  if (!Array.isArray(cash.transactions)) {
    cash.transactions = [];
  }

  cash.transactions.push(transaction);

  writeCash(cash);

  return transaction;
}

/*
 * ==========================================
 * GET /api/expenses
 *
 * Расходы ТЕКУЩЕГО филиала
 * ==========================================
 */

router.get("/", (req, res) => {
  try {
    const expenses = readExpenses();

    return res.json(expenses);
  } catch (error) {
    console.error("Ошибка получения расходов:", error);

    return res.status(500).json({
      message: "Не удалось загрузить расходы",
    });
  }
});

/*
 * ==========================================
 * GET /api/expenses/categories
 *
 * Категории ТЕКУЩЕГО филиала
 * ==========================================
 */

router.get("/categories", (req, res) => {
  try {
    const expenses = readExpenses();

    const usedCategories = expenses
      .map((expense) => expense.category)
      .filter(Boolean);

    const categories = [...new Set([...DEFAULT_CATEGORIES, ...usedCategories])];

    return res.json(categories);
  } catch (error) {
    console.error("Ошибка получения категорий:", error);

    return res.status(500).json({
      message: "Не удалось загрузить категории",
    });
  }
});

/*
 * ==========================================
 * POST /api/expenses
 *
 * Создание расхода
 * ТОЛЬКО в текущем филиале
 * ==========================================
 */

router.post("/", (req, res) => {
  try {
    const { amount, category, comment, date } = req.body;

    const normalizedAmount = Number(amount);

    if (!Number.isFinite(normalizedAmount) || normalizedAmount <= 0) {
      return res.status(400).json({
        message: "Укажите корректную сумму расхода",
      });
    }

    if (!category || !String(category).trim()) {
      return res.status(400).json({
        message: "Укажите категорию расхода",
      });
    }

    const finalAmount = Number(normalizedAmount.toFixed(2));

    const expenses = readExpenses();

    const expenseId = Date.now().toString();

    const expense = {
      id: expenseId,

      amount: finalAmount,

      category: String(category).trim(),

      comment: comment ? String(comment).trim() : "",

      createdAt: date || new Date().toISOString(),
    };

    /*
     * Сначала списываем
     * деньги текущего филиала
     */

    const cashTransaction = addExpenseToCash(finalAmount, expense);

    /*
     * Сохраняем расход
     * текущего филиала
     */

    expenses.unshift(expense);

    writeExpenses(expenses);

    return res.status(201).json({
      success: true,

      expense,

      cashTransaction,
    });
  } catch (error) {
    console.error("Ошибка создания расхода:", error);

    return res.status(500).json({
      success: false,

      message: error.message || "Не удалось сохранить расход",
    });
  }
});

/*
 * ==========================================
 * DELETE /api/expenses/:id
 *
 * Если понадобится вернуть DELETE,
 * он тоже будет работать только
 * с текущим филиалом, потому что
 * readExpenses/writeExpenses уже
 * филиально разделены.
 * ==========================================
 */

// router.delete(
//   "/:id",
//   (req, res) => {
//     try {
//       const { id } = req.params;
//
//       const expenses = readExpenses();
//
//       const exists = expenses.some(
//         (expense) =>
//           String(expense.id) === String(id),
//       );
//
//       if (!exists) {
//         return res.status(404).json({
//           message: "Расход не найден",
//         });
//       }
//
//       const updatedExpenses =
//         expenses.filter(
//           (expense) =>
//             String(expense.id) !== String(id),
//         );
//
//       writeExpenses(updatedExpenses);
//
//       return res.json({
//         success: true,
//         message: "Расход удалён",
//       });
//     } catch (error) {
//       console.error(
//         "Ошибка удаления расхода:",
//         error,
//       );
//
//       return res.status(500).json({
//         message:
//           "Не удалось удалить расход",
//       });
//     }
//   },
// );

module.exports = router;
