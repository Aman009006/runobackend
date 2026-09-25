
const express = require("express");
const fs = require("fs/promises");
const path = require("path");

const router = express.Router();

/*
|--------------------------------------------------------------------------
| FILES
|--------------------------------------------------------------------------
*/

const DATA_DIR = path.join(__dirname, "..", "data");

const SALES_FILE = path.join(DATA_DIR, "sales.json");
const RESERVATIONS_FILE = path.join(DATA_DIR, "reservations.json");

/*
|--------------------------------------------------------------------------
| HELPERS
|--------------------------------------------------------------------------
*/

async function readJsonFile(filePath, fallback = []) {
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

function getAmanatFromPayment(payment) {
  if (!payment) {
    return 0;
  }

  /*
   * В sales.json:
   *
   * payment.amanat       -> сумма в сомах
   * payment.amanatSom    -> сумма в сомах
   *
   * Поэтому сначала смотрим amanatSom.
   */

  if (payment.amanatSom !== undefined) {
    return toNumber(payment.amanatSom);
  }

  if (payment.amanat !== undefined) {
    /*
     * Для sales.json amanat хранится в копейках.
     */
    return toNumber(payment.amanat) / 100;
  }

  return 0;
}

function getAmanatFromReservation(reservation) {
  if (!reservation) {
    return 0;
  }

  /*
   * В reservations.json:
   *
   * payments.amanat -> сразу сомы
   */

  return toNumber(reservation.payments?.amanat);
}


/*
|--------------------------------------------------------------------------
| GET /api/moysklad/amanat
|--------------------------------------------------------------------------
|
| Пример:
|
| GET /api/moysklad/amanat
|     ?from=2026-09-01
|     &to=2026-09-30
|
|--------------------------------------------------------------------------
*/

router.get("/amanat", async (req, res) => {
  try {
    const { from, to } = req.query;

    if (!from || !to) {
      return res.status(400).json({
        success: false,
        message: "Необходимо указать from и to",
      });
    }

    /*
     * Проверяем даты.
     */

    const fromDate = new Date(`${from}T00:00:00`);
    const toDate = new Date(`${to}T23:59:59`);

    if (
      Number.isNaN(fromDate.getTime()) ||
      Number.isNaN(toDate.getTime())
    ) {
      return res.status(400).json({
        success: false,
        message: "Неверный формат даты. Используйте YYYY-MM-DD",
      });
    }

    if (from > to) {
      return res.status(400).json({
        success: false,
        message: "Дата from не может быть позже даты to",
      });
    }

    /*
     * Загружаем оба файла.
     */

    const salesData = await readJsonFile(SALES_FILE, {});
    const reservationsData = await readJsonFile(
      RESERVATIONS_FILE,
      [],
    );

    const result = [];

    /*
    |--------------------------------------------------------------------------
    | SALES
    |--------------------------------------------------------------------------
    |
    | sales.json имеет структуру:
    |
    | {
    |   "2026-09-23": [],
    |   "2026-09-24": []
    | }
    |
    */

    if (
      salesData &&
      typeof salesData === "object" &&
      !Array.isArray(salesData)
    ) {
      for (const [date, sales] of Object.entries(salesData)) {
        /*
         * Сначала проверяем дату.
         */

        if (date < from || date > to) {
          continue;
        }

        if (!Array.isArray(sales)) {
          continue;
        }

        for (const sale of sales) {
          const amanat = getAmanatFromPayment(
            sale.payment,
          );

          /*
           * В календарь попадают только продажи,
           * где реально есть Аманат.
           */

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

            customerPhone:
              sale.customerPhone ||
              sale.phone ||
              null,

            total: toNumber(sale.totalSom),

            totalKopecks: toNumber(sale.totalKopecks),

            amanat,

            amanatKopecks: Math.round(amanat * 100),

            paymentMethod:
              sale.payment?.method || null,

            payment: {
              method:
                sale.payment?.method || null,

              cash: toNumber(
                sale.payment?.cashSom ??
                  sale.payment?.cash ??
                  0,
              ),

              card: toNumber(
                sale.payment?.cardSom ??
                  sale.payment?.card ??
                  0,
              ),

              amanat,

              mplus: toNumber(
                sale.payment?.mplusSom ??
                  sale.payment?.mplus ??
                  0,
              ),
            },

            items: Array.isArray(sale.items)
              ? sale.items
              : [],

            retailStoreId:
              sale.retailStoreId || null,

            storeId:
              sale.storeId || null,

            moyskladId:
              sale.moyskladId || null,

            moyskladName:
              sale.moyskladName || null,
          });
        }
      }
    }

    /*
    |--------------------------------------------------------------------------
    | RESERVATIONS
    |--------------------------------------------------------------------------
    */

    if (Array.isArray(reservationsData)) {
      for (const reservation of reservationsData) {
        const date = reservation.reservationDate;

        if (!date) {
          continue;
        }

        /*
         * Проверяем период.
         */

        if (date < from || date > to) {
          continue;
        }

        /*
         * ОТМЕНЁННЫЕ БРОНИ НЕ ПОКАЗЫВАЕМ.
         */

        if (
          String(reservation.status).toLowerCase() ===
          "cancelled"
        ) {
          continue;
        }

        const amanat = getAmanatFromReservation(
          reservation,
        );

        /*
         * Брони без Аманата не нужны.
         */

        if (amanat <= 0) {
          continue;
        }

        result.push({
          id: reservation.id,

          type: "reservation",

          date,

          createdAt:
            reservation.createdAt || null,

          updatedAt:
            reservation.updatedAt || null,

          status:
            reservation.status || null,

          orderId: null,

          customerName:
            reservation.customerName || "Без клиента",

          customerPhone:
            reservation.customerPhone || null,

          total: toNumber(reservation.total),

          totalKopecks: Math.round(
            toNumber(reservation.total) * 100,
          ),

          amanat,

          amanatKopecks: Math.round(
            amanat * 100,
          ),

          paymentMethod:
            reservation.paymentMethod || null,

          payment: {
            method:
              reservation.paymentMethod || null,

            cash: toNumber(
              reservation.payments?.cash,
            ),

            card: toNumber(
              reservation.payments?.card,
            ),

            amanat,

            mplus: toNumber(
              reservation.payments?.mplus,
            ),
          },

          paid: toNumber(reservation.paid),

          remaining: toNumber(
            reservation.remaining,
          ),

          paymentStatus:
            reservation.paymentStatus || null,

          comment:
            reservation.comment || "",

          items: Array.isArray(
            reservation.items,
          )
            ? reservation.items
            : [],

          paymentHistory: Array.isArray(
            reservation.paymentHistory,
          )
            ? reservation.paymentHistory
            : [],
        });
      }
    }

    /*
    |--------------------------------------------------------------------------
    | SORT
    |--------------------------------------------------------------------------
    |
    | Сначала новые операции.
    */

    result.sort((a, b) => {
      const dateA = new Date(
        a.createdAt || `${a.date}T00:00:00`,
      );

      const dateB = new Date(
        b.createdAt || `${b.date}T00:00:00`,
      );

      return dateB - dateA;
    });

    /*
    |--------------------------------------------------------------------------
    | TOTAL
    |--------------------------------------------------------------------------
    */

    const total = result.reduce(
      (sum, item) => sum + item.amanat,
      0,
    );

    /*
    |--------------------------------------------------------------------------
    | DAILY TOTALS
    |--------------------------------------------------------------------------
    |
    | Это сразу удобно для календаря.
    |
    | {
    |   "2026-09-24": {
    |      amount: 5500,
    |      count: 2
    |   }
    | }
    |
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

    /*
    |--------------------------------------------------------------------------
    | RESPONSE
    |--------------------------------------------------------------------------
    */

    return res.json({
      success: true,

      from,

      to,

      total,

      totalKopecks: Math.round(total * 100),

      count: result.length,

      daily,

      items: result,
    });
  } catch (error) {
    console.error(
      "Ошибка получения Аманата:",
      error,
    );

    return res.status(500).json({
      success: false,
      message:
        error.message ||
        "Ошибка получения данных Аманата",
    });
  }
});

module.exports = router;
