const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const router = express.Router();

const DATA_DIR = path.join(__dirname, "..", "data");
const DATA_FILE = path.join(DATA_DIR, "expenses.json");
const CASH_FILE = path.join(DATA_DIR, "cash.json");

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
 * EXPENSES
 * ==========================================
 */

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, {
      recursive: true,
    });
  }

  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(
      DATA_FILE,
      JSON.stringify([], null, 2),
      "utf8",
    );
  }
}

function readExpenses() {
  ensureDataFile();

  try {
    const data = fs.readFileSync(
      DATA_FILE,
      "utf8",
    );

    if (!data.trim()) {
      return [];
    }

    const parsed = JSON.parse(data);

    return Array.isArray(parsed)
      ? parsed
      : [];
  } catch (error) {
    console.error(
      "Ошибка чтения expenses.json:",
      error,
    );

    return [];
  }
}

function writeExpenses(expenses) {
  ensureDataFile();

  fs.writeFileSync(
    DATA_FILE,
    JSON.stringify(
      expenses,
      null,
      2,
    ),
    "utf8",
  );
}

/*
 * ==========================================
 * CASH
 * ==========================================
 */

function ensureCashFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, {
      recursive: true,
    });
  }

  if (!fs.existsSync(CASH_FILE)) {
    fs.writeFileSync(
      CASH_FILE,
      JSON.stringify(
        {
          balance: 0,
          transactions: [],
        },
        null,
        2,
      ),
      "utf8",
    );
  }
}

function readCash() {
  ensureCashFile();

  try {
    const data = fs.readFileSync(
      CASH_FILE,
      "utf8",
    );

    if (!data.trim()) {
      return {
        balance: 0,
        transactions: [],
      };
    }

    const parsed = JSON.parse(data);

    if (
      !parsed ||
      typeof parsed !== "object"
    ) {
      return {
        balance: 0,
        transactions: [],
      };
    }

    if (
      !Array.isArray(
        parsed.transactions,
      )
    ) {
      parsed.transactions = [];
    }

    if (
      !Number.isFinite(
        Number(parsed.balance),
      )
    ) {
      parsed.balance = 0;
    }

    return parsed;
  } catch (error) {
    console.error(
      "Ошибка чтения cash.json:",
      error,
    );

    throw new Error(
      "Не удалось прочитать cash.json",
    );
  }
}

function writeCash(cash) {
  ensureCashFile();

  fs.writeFileSync(
    CASH_FILE,
    JSON.stringify(
      cash,
      null,
      2,
    ),
    "utf8",
  );
}

/*
 * ==========================================
 * СПИСАНИЕ РАСХОДА ИЗ КАССЫ
 * ==========================================
 */

function addExpenseToCash(amount, expense) {
  const expenseAmount = Number(amount);

  if (
    !Number.isFinite(expenseAmount) ||
    expenseAmount <= 0
  ) {
    throw new Error(
      "Некорректная сумма расхода",
    );
  }

  const cash = readCash();

  const balanceBefore = Number(
    cash.balance || 0,
  );

  const balanceAfter =
    balanceBefore - expenseAmount;

  const transaction = {
    id:
      `CASH-EXPENSE-${Date.now()}-` +
      crypto.randomUUID().slice(0, 8),

    type: "Rashod",

    amount: -expenseAmount,

    balanceBefore,

    balanceAfter,

    expenseId: expense.id,

    category: expense.category,

    comment: expense.comment || "",

    createdAt:
      new Date().toISOString(),
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
 * Все расходы за всё время.
 * ==========================================
 */

router.get("/", (req, res) => {
  try {
    const expenses =
      readExpenses();

    return res.json(
      expenses,
    );
  } catch (error) {
    console.error(
      "Ошибка получения расходов:",
      error,
    );

    return res.status(500).json({
      message:
        "Не удалось загрузить расходы",
    });
  }
});

/*
 * ==========================================
 * GET /api/expenses/categories
 *
 * Стандартные категории +
 * пользовательские категории.
 * ==========================================
 */

router.get(
  "/categories",
  (req, res) => {
    try {
      const expenses =
        readExpenses();

      const usedCategories =
        expenses
          .map(
            (expense) =>
              expense.category,
          )
          .filter(Boolean);

      const categories = [
        ...new Set([
          ...DEFAULT_CATEGORIES,
          ...usedCategories,
        ]),
      ];

      return res.json(
        categories,
      );
    } catch (error) {
      console.error(
        "Ошибка получения категорий:",
        error,
      );

      return res.status(500).json({
        message:
          "Не удалось загрузить категории",
      });
    }
  },
);

/*
 * ==========================================
 * POST /api/expenses
 *
 * Создание расхода.
 *
 * Теперь при создании:
 *
 * 1. Проверяется баланс кассы
 * 2. Деньги списываются из cash.json
 * 3. Создаётся транзакция type: "Rashod"
 * 4. Сохраняется расход
 * ==========================================
 */

router.post(
  "/",
  (req, res) => {
    try {
      const {
        amount,
        category,
        comment,
        date,
      } = req.body;

      const normalizedAmount =
        Number(amount);

      /*
       * Проверяем сумму
       */
      if (
        !Number.isFinite(
          normalizedAmount,
        ) ||
        normalizedAmount <= 0
      ) {
        return res.status(400).json({
          message:
            "Укажите корректную сумму расхода",
        });
      }

      /*
       * Проверяем категорию
       */
      if (
        !category ||
        !String(category).trim()
      ) {
        return res.status(400).json({
          message:
            "Укажите категорию расхода",
        });
      }

      /*
       * Нормализуем сумму
       */
      const finalAmount =
        Number(
          normalizedAmount.toFixed(
            2,
          ),
        );

      /*
       * Читаем расходы
       */
      const expenses =
        readExpenses();

      /*
       * Создаём ID расхода
       */
      const expenseId =
        Date.now().toString();

      /*
       * Создаём расход
       */
      const expense = {
        id: expenseId,

        amount:
          finalAmount,

        category:
          String(
            category,
          ).trim(),

        comment: comment
          ? String(
              comment,
            ).trim()
          : "",

        createdAt:
          date ||
          new Date().toISOString(),
      };

      /*
       * ======================================
       * СНАЧАЛА СПИСЫВАЕМ ДЕНЬГИ ИЗ КАССЫ
       * ======================================
       *
       * Если денег недостаточно,
       * addExpenseToCash выбросит ошибку.
       *
       * В таком случае расход
       * НЕ будет добавлен в expenses.json.
       */

      const cashTransaction =
        addExpenseToCash(
          finalAmount,
          expense,
        );

      /*
       * ======================================
       * СОХРАНЯЕМ РАСХОД
       * ======================================
       */

      expenses.unshift(
        expense,
      );

      writeExpenses(
        expenses,
      );

      /*
       * Возвращаем расход
       * + информацию о кассе
       */

      return res.status(201).json({
        success: true,

        expense,

        cashTransaction,
      });
    } catch (error) {
      console.error(
        "Ошибка создания расхода:",
        error,
      );

      return res.status(500).json({
        success: false,

        message:
          error.message ||
          "Не удалось сохранить расход",
      });
    }
  },
);

/*
 * ==========================================
 * DELETE /api/expenses/:id
 *
 * Удаление расхода.
 *
 * ВАЖНО:
 * Деньги обратно в кассу здесь
 * пока НЕ возвращаются.
 * ==========================================
 */

// router.delete(
//   "/:id",
//   (req, res) => {
//     try {
//       const { id } =
//         req.params;

//       const expenses =
//         readExpenses();

//       const exists =
//         expenses.some(
//           (expense) =>
//             String(
//               expense.id,
//             ) === String(id),
//         );

//       if (!exists) {
//         return res.status(404).json({
//           message:
//             "Расход не найден",
//         });
//       }

//       const updatedExpenses =
//         expenses.filter(
//           (expense) =>
//             String(
//               expense.id,
//             ) !== String(id),
//         );

//       writeExpenses(
//         updatedExpenses,
//       );

//       return res.json({
//         success: true,

//         message:
//           "Расход удалён",
//       });
//     } catch (error) {
//       console.error(
//         "Ошибка удаления расхода:",
//         error,
//       );

//       return res.status(500).json({
//         message:
//           "Не удалось удалить расход",
//       });
//     }
//   },
// );

module.exports = router;