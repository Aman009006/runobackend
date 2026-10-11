const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const router = express.Router();

const DATA_DIR = path.join(__dirname, "..", "data");
const DATA_FILE = path.join(DATA_DIR, "budget.json");

/*
|--------------------------------------------------------------------------
| ЧТЕНИЕ И ЗАПИСЬ JSON
|--------------------------------------------------------------------------
*/


async function readDatabase() {
  const emptyDatabase = {
    topups: [],
    people: [],
    transactions: [],
    totals: {},
  };

  try {
    const content = await fs.readFile(DATA_FILE, "utf8");

    // Файл существует, но пустой
    if (!content.trim()) {
      return emptyDatabase;
    }

    const parsed = JSON.parse(content);

    // JSON должен содержать объект
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return emptyDatabase;
    }

    return parsed;
  } catch (error) {
    // Файл ещё не создан
    if (error.code === "ENOENT") {
      return emptyDatabase;
    }

    // Некорректный JSON
    if (error instanceof SyntaxError) {
      console.error(
        "budget.json содержит некорректный JSON. Используются пустые данные.",
        error.message,
      );

      return emptyDatabase;
    }

    // Другие ошибки файловой системы не скрываем
    throw error;
  }
}


async function writeDatabase(data) {
  await fs.mkdir(DATA_DIR, { recursive: true });

  const tempFile = `${DATA_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`;

  await fs.writeFile(
    tempFile,
    JSON.stringify(data, null, 2),
    "utf8",
  );

  await fs.rename(tempFile, DATA_FILE);
}

/*
|--------------------------------------------------------------------------
| ОБРАБОТКА ДАННЫХ
|--------------------------------------------------------------------------
*/

function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function parsePositiveAmount(value) {
  const amount = Number(value);

  if (
    !Number.isFinite(amount) ||
    amount <= 0 ||
    amount > 1_000_000_000
  ) {
    return null;
  }

  return roundMoney(amount);
}

function normalizeDatabase(source) {
  const database =
    source && typeof source === "object" && !Array.isArray(source)
      ? source
      : {};

  const topups = Array.isArray(database.topups)
    ? database.topups
    : [];

  let people = Array.isArray(database.people)
    ? database.people
    : [];

  // Совместимость со старым форматом entries.
  if (!people.length && Array.isArray(database.entries)) {
    people = database.entries.map((entry) => ({
      ...entry,
      status:
        entry.status ||
        (entry.type === "received" ? "received" : "waiting"),
      receivedAt:
        entry.receivedAt ||
        (entry.type === "received" ? entry.createdAt : null),
    }));
  }

 return {
  ...database,
  topups,
  people,
  transactions: Array.isArray(database.transactions)
    ? database.transactions
    : [],
  totals:
    database.totals &&
    typeof database.totals === "object" &&
    !Array.isArray(database.totals)
      ? database.totals
      : {},
};
}

function calculateTotals(data) {
  const topups = roundMoney(
    data.topups.reduce(
      (sum, item) => sum + Number(item.amount || 0),
      0,
    ),
  );

  const spent = roundMoney(
    data.people
      .filter((person) => person.status === "received")
      .reduce(
        (sum, person) => sum + Number(person.amount || 0),
        0,
      ),
  );

  return {
    topups,
    spent,
    issued: spent, // Совместимость со старым кодом
    balance: roundMoney(topups - spent),
    updatedAt: new Date().toISOString(),
  };
}
function buildTransactions(data) {
  const topupTransactions = data.topups.map((item) => ({
    id: item.id,
    type: "topup",
    label: "Пополнение бюджета",
    amount: Number(item.amount || 0),
    comment: item.comment || "",
    createdAt: item.createdAt,
  }));

  const issuedTransactions = data.people
    .filter((person) => person.status === "received")
    .map((person) => ({
      id: `issued-${person.id}`,
      personId: person.id,
      type: "issued",
      label: "Выдача человеку",
      name: person.name,
      phone: person.phone || "",
      amount: Number(person.amount || 0),
      comment: person.comment || "",
      createdAt: person.receivedAt || person.createdAt,
    }));

  return [...topupTransactions, ...issuedTransactions].sort(
    (a, b) =>
      new Date(b.createdAt || 0) - new Date(a.createdAt || 0),
  );
}

async function getCurrentData() {
  const database = normalizeDatabase(await readDatabase());

  return { database };
}

async function persistDatabase(database) {
  database.totals = calculateTotals(database);
  database.transactions = buildTransactions(database);

  await writeDatabase(database);
}

/*
|--------------------------------------------------------------------------
| GET /api/budget
| Общий бюджет, ожидающие, получившие и история транзакций
|--------------------------------------------------------------------------
*/

router.get("/", async (req, res) => {
  try {
    const { database } = await getCurrentData();

    // Если старый файл ещё не содержит totals,
    // один раз создаём начальные значения.
    if (
      !Number.isFinite(Number(database.totals.topups)) ||
      !Number.isFinite(Number(database.totals.spent)) ||
      !Number.isFinite(Number(database.totals.balance))
    ) {
      await persistDatabase(database);
    }

    return res.json({
      success: true,
      ...database,
    });
  } catch (error) {
    console.error("GET /api/budget:", error);

    return res.status(500).json({
      success: false,
      message: "Не удалось загрузить бюджет",
    });
  }
});

/*
|--------------------------------------------------------------------------
| POST /api/budget/topups
| Пополнение общего бюджета
|--------------------------------------------------------------------------
*/

router.post("/topups", async (req, res) => {
  try {
    const amount = parsePositiveAmount(req.body?.amount);

    if (amount === null) {
      return res.status(400).json({
        success: false,
        message: "Укажите корректную сумму пополнения",
      });
    }

    const { database } = await getCurrentData();

    const topup = {
      id: crypto.randomUUID(),
      amount,
      comment: String(req.body?.comment || "")
        .trim()
        .slice(0, 1000),
      createdAt: new Date().toISOString(),
    };

    database.topups.unshift(topup);

    await persistDatabase(database);

    return res.status(201).json({
      success: true,
      topup,
      totals: database.totals,
      transactions: database.transactions,
    });
  } catch (error) {
    console.error("POST /api/budget/topups:", error);

    return res.status(500).json({
      success: false,
      message: "Не удалось пополнить бюджет",
    });
  }
});

/*
|--------------------------------------------------------------------------
| POST /api/budget/entries
| Добавление человека в список ожидающих
|--------------------------------------------------------------------------
*/

router.post("/entries", async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    const phone = String(req.body?.phone || "").trim();
    const comment = String(req.body?.comment || "").trim();
    const amount = parsePositiveAmount(req.body?.amount);

    if (!name || name.length > 200) {
      return res.status(400).json({
        success: false,
        message: "Укажите имя (до 200 символов)",
      });
    }

    if (phone.length > 60 || comment.length > 1000) {
      return res.status(400).json({
        success: false,
        message: "Слишком длинный номер или комментарий",
      });
    }

    if (amount === null) {
      return res.status(400).json({
        success: false,
        message: "Укажите корректную сумму",
      });
    }

    const { database } = await getCurrentData();

    const person = {
      id: crypto.randomUUID(),
      name,
      phone,
      amount,
      comment,
      status: "waiting",
      createdAt: new Date().toISOString(),
      receivedAt: null,
    };

    database.people.unshift(person);

    await persistDatabase(database);

    return res.status(201).json({
      success: true,
      person,
      totals: database.totals,
    });
  } catch (error) {
    console.error("POST /api/budget/entries:", error);

    return res.status(500).json({
      success: false,
      message: "Не удалось добавить человека",
    });
  }
});

/*
|--------------------------------------------------------------------------
| PATCH /api/budget/entries/:id/received
| Подтверждение получения и списание из общего бюджета
|--------------------------------------------------------------------------
*/

router.patch("/entries/:id/received", async (req, res) => {
  try {
    const { database } = await getCurrentData();

    const person = database.people.find(
      (item) => String(item.id) === String(req.params.id),
    );

    if (!person) {
      return res.status(404).json({
        success: false,
        message: "Запись не найдена",
      });
    }

    if (person.status === "received") {
      return res.status(409).json({
        success: false,
        message: "Эта запись уже отмечена как полученная",
      });
    }

    const totals = calculateTotals(database);

    if (Number(person.amount) > totals.balance) {
      return res.status(400).json({
        success: false,
        message: `Недостаточно средств. Доступно: ${totals.balance.toFixed(2)} сом`,
      });
    }

    person.status = "received";
    person.receivedAt = new Date().toISOString();

    await persistDatabase(database);

    return res.json({
      success: true,
      person,
      totals: database.totals,
      transactions: database.transactions,
    });
  } catch (error) {
    console.error(
      "PATCH /api/budget/entries/:id/received:",
      error,
    );

    return res.status(500).json({
      success: false,
      message: "Не удалось подтвердить получение",
    });
  }
});

module.exports = router;
