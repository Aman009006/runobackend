const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const { getCurrentBranch } = require("./branchContext");

const router = express.Router();

/*
|--------------------------------------------------------------------------
| FILES
|--------------------------------------------------------------------------
*/

const DATA_DIR = path.join(__dirname, "..", "data");

const SALES_FILE = path.join(DATA_DIR, "sales.json");
const RESERVATIONS_FILE = path.join(DATA_DIR, "reservations.json");

const BRANCHES = ["bishkek", "dordoy", "osh"];

/*
|--------------------------------------------------------------------------
| HELPERS
|--------------------------------------------------------------------------
*/

async function readJsonFile(filePath, fallback = {}) {
  try {
    const data = await fs.readFile(filePath, "utf8");

    if (!data.trim()) {
      return fallback;
    }

    return JSON.parse(data);
  } catch (error) {
    if (error.code === "ENOENT") {
      return fallback;
    }

    throw error;
  }
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function normalizeBranchKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

/*
|--------------------------------------------------------------------------
| CURRENT BRANCH KEY
|--------------------------------------------------------------------------
*/

function getBranchKey(branch) {
  const candidates = [branch?.key, branch?.code, branch?.slug, branch?.id];

  for (const candidate of candidates) {
    const key = normalizeBranchKey(candidate);

    if (BRANCHES.includes(key)) {
      return key;
    }
  }

  const name = normalizeBranchKey(branch?.name || branch?.title);

  if (name.includes("бишкек") || name.includes("bishkek")) {
    return "bishkek";
  }

  if (name.includes("дордой") || name.includes("dordoy")) {
    return "dordoy";
  }

  if (name.includes("ош") || name === "osh") {
    return "osh";
  }

  throw new Error(`Не удалось определить филиал: ${JSON.stringify(branch)}`);
}

/*
|--------------------------------------------------------------------------
| RESERVATION BRANCH
|--------------------------------------------------------------------------
*/

function getReservationBranchKey(reservation) {
  const candidates = [
    reservation?.branchKey,
    reservation?.branchId,
    reservation?.branch,
    reservation?.branchName,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      const key = normalizeBranchKey(candidate);

      if (BRANCHES.includes(key)) {
        return key;
      }

      if (key.includes("бишкек") || key.includes("bishkek")) {
        return "bishkek";
      }

      if (key.includes("дордой") || key.includes("dordoy")) {
        return "dordoy";
      }

      if (key === "ош" || key === "osh") {
        return "osh";
      }
    }

    if (candidate && typeof candidate === "object") {
      try {
        return getBranchKey(candidate);
      } catch {
        // Проверяем следующее поле филиала.
      }
    }
  }

  return null;
}

/*
|--------------------------------------------------------------------------
| AMANAT AMOUNTS
|--------------------------------------------------------------------------
|
| sales.json:
| payment.amanatSom -> сомы
| payment.amanat    -> тыйыны, если amanatSom отсутствует
|
| reservations.json:
| payments.amanat -> сомы
|--------------------------------------------------------------------------
*/

function getAmanatFromPayment(payment) {
  if (!payment) {
    return 0;
  }

  if (payment.amanatSom !== undefined && payment.amanatSom !== null) {
    return toNumber(payment.amanatSom);
  }

  if (payment.amanat !== undefined && payment.amanat !== null) {
    return toNumber(payment.amanat) / 100;
  }

  return 0;
}

function getAmanatFromReservation(reservation) {
  return toNumber(reservation?.payments?.amanat);
}

/*
|--------------------------------------------------------------------------
| PAYMENT NORMALIZATION
|--------------------------------------------------------------------------
*/

function getSalePaymentAmount(payment, somKey, legacyKey) {
  if (!payment) {
    return 0;
  }

  if (payment[somKey] !== undefined && payment[somKey] !== null) {
    return toNumber(payment[somKey]);
  }

  // Старые поля cash/card/mplus хранятся в тыйынах.
  return toNumber(payment[legacyKey]) / 100;
}

/*
|--------------------------------------------------------------------------
| GET /api/moysklad/amanat?from=YYYY-MM-DD&to=YYYY-MM-DD
|--------------------------------------------------------------------------
*/

router.get("/amanat", async (req, res) => {
  try {
    const { from, to } = req.query;

    /*
    |--------------------------------------------------------------------------
    | VALIDATE DATES
    |--------------------------------------------------------------------------
    */

    if (!from || !to) {
      return res.status(400).json({
        success: false,
        message: "Необходимо указать from и to",
      });
    }

    const datePattern = /^\d{4}-\d{2}-\d{2}$/;

    if (!datePattern.test(from) || !datePattern.test(to)) {
      return res.status(400).json({
        success: false,
        message: "Неверный формат даты. Используйте YYYY-MM-DD",
      });
    }

    const fromDate = new Date(`${from}T00:00:00Z`);
    const toDate = new Date(`${to}T00:00:00Z`);

    if (
      Number.isNaN(fromDate.getTime()) ||
      Number.isNaN(toDate.getTime()) ||
      fromDate.toISOString().slice(0, 10) !== from ||
      toDate.toISOString().slice(0, 10) !== to
    ) {
      return res.status(400).json({
        success: false,
        message: "Указана некорректная дата",
      });
    }

    if (from > to) {
      return res.status(400).json({
        success: false,
        message: "Дата from не может быть позже даты to",
      });
    }

    /*
    |--------------------------------------------------------------------------
    | CURRENT BRANCH
    |--------------------------------------------------------------------------
    */

    const branch = getCurrentBranch();
    const branchKey = getBranchKey(branch);

    /*
    |--------------------------------------------------------------------------
    | LOAD FILES
    |--------------------------------------------------------------------------
    */

    const [salesData, reservationsData] = await Promise.all([
      readJsonFile(SALES_FILE, {}),
      readJsonFile(RESERVATIONS_FILE, []),
    ]);

    const result = [];

    /*
    |--------------------------------------------------------------------------
    | SALES: CURRENT BRANCH ONLY
    |--------------------------------------------------------------------------
    |
    | Ожидаемая структура sales.json:
    |
    | {
    |   "bishkek": {
    |     "2026-09-28": [...]
    |   },
    |   "dordoy": {
    |     "2026-09-28": [...]
    |   },
    |   "osh": {
    |     "2026-09-28": [...]
    |   }
    | }
    |--------------------------------------------------------------------------
    */

    const salesByDate = salesData?.[branchKey] || {};

    if (
      salesByDate &&
      typeof salesByDate === "object" &&
      !Array.isArray(salesByDate)
    ) {
      for (const [date, sales] of Object.entries(salesByDate)) {
        if (date < from || date > to) {
          continue;
        }

        if (!Array.isArray(sales)) {
          continue;
        }

        for (const sale of sales) {
          if (String(sale.status || "").toLowerCase() === "cancelled") {
            continue;
          }

          const amanat = getAmanatFromPayment(sale.payment);

          if (amanat <= 0) {
            continue;
          }

          result.push({
            id: sale.id,
            type: "sale",
            date,
            createdAt: sale.createdAt || null,
            status: sale.status || "completed",
            orderId: sale.orderId || null,

            customerName:
              sale.customerName ||
              sale.counterpartyName ||
              sale.agent?.name ||
              null,

            customerPhone: sale.customerPhone || sale.phone || null,

            total: toNumber(sale.totalSom),
            totalKopecks: toNumber(sale.totalKopecks),

            amanat,
            amanatKopecks: Math.round(amanat * 100),

            paymentMethod: sale.payment?.method || null,

            payment: {
              method: sale.payment?.method || null,

              cash: getSalePaymentAmount(sale.payment, "cashSom", "cash"),

              card: getSalePaymentAmount(sale.payment, "cardSom", "card"),

              amanat,

              mplus: getSalePaymentAmount(sale.payment, "mplusSom", "mplus"),

              online_qr: getSalePaymentAmount(
                sale.payment,
                "online_qrSom",
                "online_qr",
              ),
            },

            items: Array.isArray(sale.items) ? sale.items : [],

            retailStoreId: sale.retailStoreId || null,
            storeId: sale.storeId || null,
            moyskladId: sale.moyskladId || null,
            moyskladName: sale.moyskladName || null,
          });
        }
      }
    }

    /*
    |--------------------------------------------------------------------------
    | RESERVATIONS: CURRENT BRANCH ONLY
    |--------------------------------------------------------------------------
    |
    | Поддерживаем два формата reservations.json:
    |
    | 1. Массив броней с branchKey / branchId / branchName.
    |
    | 2. Объект, разделённый по филиалам:
    |
    | {
    |   "bishkek": [...],
    |   "dordoy": [...],
    |   "osh": [...]
    | }
    |
    | Также поддерживается объект с датами внутри филиала.
    |--------------------------------------------------------------------------
    */

    let reservations = [];

    if (Array.isArray(reservationsData)) {
      // В общем массиве берём только брони текущего филиала.
      reservations = reservationsData.filter(
        (reservation) => getReservationBranchKey(reservation) === branchKey,
      );
    } else if (reservationsData && typeof reservationsData === "object") {
      const branchReservations = reservationsData[branchKey];

      if (Array.isArray(branchReservations)) {
        reservations = branchReservations;
      } else if (branchReservations && typeof branchReservations === "object") {
        // Формат: филиал -> дата -> массив броней.
        reservations = Object.entries(branchReservations).flatMap(
          ([date, items]) => {
            if (!Array.isArray(items)) {
              return [];
            }

            return items.map((reservation) => ({
              ...reservation,
              reservationDate: reservation.reservationDate || date,
            }));
          },
        );
      }
    }

    for (const reservation of reservations) {
      const date = reservation.reservationDate;

      if (!date || date < from || date > to) {
        continue;
      }

      if (String(reservation.status || "").toLowerCase() === "cancelled") {
        continue;
      }

      const amanat = getAmanatFromReservation(reservation);

      if (amanat <= 0) {
        continue;
      }

      result.push({
        id: reservation.id,
        type: "reservation",
        date,

        createdAt: reservation.createdAt || null,
        updatedAt: reservation.updatedAt || null,
        status: reservation.status || null,

        orderId: null,

        customerName: reservation.customerName || "Без клиента",
        customerPhone: reservation.customerPhone || null,

        total: toNumber(reservation.total),
        totalKopecks: Math.round(toNumber(reservation.total) * 100),

        amanat,
        amanatKopecks: Math.round(amanat * 100),

        paymentMethod: reservation.paymentMethod || null,

        payment: {
          method: reservation.paymentMethod || null,
          cash: toNumber(reservation.payments?.cash),
          card: toNumber(reservation.payments?.card),
          amanat,
          mplus: toNumber(reservation.payments?.mplus),
          online_qr: toNumber(reservation.payments?.online_qr),
        },

        paid: toNumber(reservation.paid),
        remaining: toNumber(reservation.remaining),

        paymentStatus: reservation.paymentStatus || null,
        comment: reservation.comment || "",

        items: Array.isArray(reservation.items) ? reservation.items : [],

        paymentHistory: Array.isArray(reservation.paymentHistory)
          ? reservation.paymentHistory
          : [],
      });
    }

    /*
    |--------------------------------------------------------------------------
    | SORT: NEWEST FIRST
    |--------------------------------------------------------------------------
    */

    result.sort((a, b) => {
      const dateA = new Date(a.createdAt || `${a.date}T00:00:00`);

      const dateB = new Date(b.createdAt || `${b.date}T00:00:00`);

      return dateB - dateA;
    });

    /*
    |--------------------------------------------------------------------------
    | TOTAL
    |--------------------------------------------------------------------------
    */

    const total = result.reduce((sum, item) => sum + item.amanat, 0);

    /*
    |--------------------------------------------------------------------------
    | DAILY TOTALS
    |--------------------------------------------------------------------------
    */

    const daily = {};

    for (const item of result) {
      if (!daily[item.date]) {
        daily[item.date] = {
          amount: 0,
          count: 0,
        };
      }

      daily[item.date].amount += item.amanat;
      daily[item.date].count += 1;
    }

    // Округляем дневные суммы до двух знаков после запятой.
    for (const day of Object.values(daily)) {
      day.amount = Math.round(day.amount * 100) / 100;
    }

    /*
    |--------------------------------------------------------------------------
    | RESPONSE
    |--------------------------------------------------------------------------
    */

    return res.json({
      success: true,
      branch: branchKey,
      from,
      to,

      total: Math.round(total * 100) / 100,
      totalKopecks: Math.round(total * 100),

      count: result.length,
      daily,
      items: result,
    });
  } catch (error) {
    console.error("Ошибка получения Аманата:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Ошибка получения данных Аманата",
    });
  }
});

module.exports = router;
