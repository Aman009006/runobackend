const express = require("express");
const fs = require("fs/promises");
const path = require("path");

const router = express.Router();

const DATA_DIR = path.join(__dirname, "..", "data");

const multer = require("multer");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 20 * 1024 * 1024,
  },
});

/*
|--------------------------------------------------------------------------
| HELPERS
|--------------------------------------------------------------------------
*/

async function readJson(fileName, fallback = null) {
  try {
    const filePath = path.join(DATA_DIR, fileName);
    const content = await fs.readFile(filePath, "utf8");

    return JSON.parse(content);
  } catch (error) {
    console.error(`Ошибка чтения файла ${fileName}:`, error.message);

    return fallback;
  }
}

function toNumber(value) {
  const number = Number(value);

  return Number.isFinite(number) ? number : 0;
}

function getDate(value) {
  if (!value) {
    return null;
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date;
}

function getDayKey(date) {
  if (!date) {
    return null;
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function isDateInRange(date, from, to) {
  if (!date) {
    return false;
  }

  if (from && date < from) {
    return false;
  }

  if (to && date > to) {
    return false;
  }

  return true;
}

function normalizeDateRange(from, to) {
  let fromDate = null;
  let toDate = null;

  if (from) {
    fromDate = new Date(`${from}T00:00:00`);
  }

  if (to) {
    toDate = new Date(`${to}T23:59:59.999`);
  }

  return {
    from: fromDate,
    to: toDate,
  };
}

function emptyDay() {
  return {
    sales: 0,
    reservations: 0,
    expenses: 0,
    returns: 0,
    supplierPayments: 0,
    deposits: 0,
    withdraws: 0,
    net: 0,
  };
}

/*
|--------------------------------------------------------------------------
| PAYMENT HELPERS
|--------------------------------------------------------------------------
*/

function getPaymentObject(item) {
  if (!item || typeof item !== "object") {
    return {};
  }

  if (
    item.payment &&
    typeof item.payment === "object" &&
    !Array.isArray(item.payment)
  ) {
    return item.payment;
  }

  return item;
}

function getPaymentAmount(payment, keys) {
  for (const key of keys) {
    if (
      payment[key] !== undefined &&
      payment[key] !== null &&
      payment[key] !== ""
    ) {
      return Math.abs(toNumber(payment[key]));
    }
  }

  return 0;
}

function normalizeSalesData(sales) {
  if (Array.isArray(sales)) {
    return sales;
  }

  if (sales && typeof sales === "object" && !Array.isArray(sales)) {
    return Object.values(sales).flatMap((daySales) => {
      return Array.isArray(daySales) ? daySales : [];
    });
  }

  return [];
}

function addPaymentToSummary(
  salesByPayment,
  item,
  fallbackAmount = 0,
) {
  const payment = getPaymentObject(item);

  /*
  |--------------------------------------------------------------------------
  | В sales.json платежи хранятся в копейках
  |--------------------------------------------------------------------------
  */

  const cashKopecks = getPaymentAmount(payment, ["cash"]);

  const cardKopecks = getPaymentAmount(payment, ["card"]);

  const amanatKopecks = getPaymentAmount(payment, [
    "amanat",
    "credit",
  ]);

  const mplusKopecks = getPaymentAmount(payment, [
    "mplus",
    "delivery",
  ]);

  const localKopecks = getPaymentAmount(payment, [
    "local",
    "localPayment",
  ]);

  const onlineQrKopecks = getPaymentAmount(payment, [
    "online_qr",
    "onlineQr",
    "onlineQR",
  ]);

  const hasPaymentFields =
    cashKopecks > 0 ||
    cardKopecks > 0 ||
    amanatKopecks > 0 ||
    mplusKopecks > 0 ||
    localKopecks > 0 ||
    onlineQrKopecks > 0;

  if (hasPaymentFields) {
    const cash = cashKopecks / 100;
    const card = cardKopecks / 100;
    const amanat = amanatKopecks / 100;
    const mplus = mplusKopecks / 100;
    const local = localKopecks / 100;
    const onlineQr = onlineQrKopecks / 100;

    salesByPayment.cash += cash;
    salesByPayment.card += card;
    salesByPayment.amanat += amanat;
    salesByPayment.mplus += mplus;
    salesByPayment.local += local;
    salesByPayment.online_qr += onlineQr;

    return (
      cash +
      card +
      amanat +
      mplus +
      local +
      onlineQr
    );
  }

  const method =
    payment.method ||
    payment.paymentMethod ||
    payment.paymentType ||
    item?.method ||
    item?.paymentMethod ||
    item?.paymentType;

  const amount = Math.abs(
    toNumber(
      fallbackAmount ||
        item?.totalSom ||
        item?.total ||
        item?.sum ||
        item?.amount,
    ),
  );

  const normalizedMethod = String(method || "")
    .trim()
    .toLowerCase();

  switch (normalizedMethod) {
    case "card":
    case "карта":
    case "bank_card":
      salesByPayment.card += amount;
      break;

    case "amanat":
    case "кредит":
    case "credit":
      salesByPayment.amanat += amount;
      break;

    case "mplus":
    case "m+":
    case "m_plus":
      salesByPayment.mplus += amount;
      break;

    case "local":
    case "localpayment":
    case "local_payment":
    case "локальная":
    case "локальная оплата":
      salesByPayment.local += amount;
      break;

    case "online_qr":
    case "onlineqr":
    case "online-qr":
    case "online qr":
    case "онлайн qr":
    case "онлайн-qr":
    case "онлайн":
    case "qr":
      salesByPayment.online_qr += amount;
      break;

    case "cash":
    case "наличные":
    case "":
    default:
      salesByPayment.cash += amount;
      break;
  }

  return amount;
}

/*
|--------------------------------------------------------------------------
| RESERVATION HELPERS
|--------------------------------------------------------------------------
*/

/**
 * Получаем ID брони из кассовой транзакции.
 *
 * Поддерживаются разные варианты,
 * которые могли использоваться в старых версиях.
 */
function getReservationIdFromTransaction(transaction) {
  if (!transaction || typeof transaction !== "object") {
    return null;
  }

  return (
    transaction.reservationId ||
    transaction.bookingId ||
    transaction.reservation?.id ||
    transaction.booking?.id ||
    null
  );
}

/*
|--------------------------------------------------------------------------
| ROUTE: REPORTS
|--------------------------------------------------------------------------
*/

router.get("/", async (req, res) => {
  try {
    const { from = "", to = "" } = req.query;

    const range = normalizeDateRange(from, to);

    /*
    |--------------------------------------------------------------------------
    | Читаем основные JSON-файлы
    |--------------------------------------------------------------------------
    */

    const cash = await readJson("cash.json", {
      balance: 0,
      transactions: [],
    });

    const expenses = await readJson("expenses.json", []);

    const sales = await readJson("sales.json", []);

    const reservations = await readJson("reservations.json", []);

    const purchases = await readJson("purchases.json", []);

    const transfers = await readJson("transfers.json", []);

    const returns = await readJson("returns.json", []);

    const salesArray = normalizeSalesData(sales);

    /*
    |--------------------------------------------------------------------------
    | RESERVATIONS
    |--------------------------------------------------------------------------
    */

    const reservationsArray = Array.isArray(reservations)
      ? reservations
      : [];

    /*
    |--------------------------------------------------------------------------
    | ID ОТМЕНЁННЫХ БРОНЕЙ
    |--------------------------------------------------------------------------
    */

    const cancelledReservationIds = new Set(
      reservationsArray
        .filter(
          (reservation) =>
            String(reservation.status || "").toLowerCase() ===
            "cancelled",
        )
        .filter((reservation) => reservation.id)
        .map((reservation) => String(reservation.id)),
    );

    /*
    |--------------------------------------------------------------------------
    | Только действующие брони
    |--------------------------------------------------------------------------
    */

    const activeReservations = reservationsArray.filter(
      (reservation) =>
        String(reservation.status || "").toLowerCase() !==
        "cancelled",
    );

    /*
    |--------------------------------------------------------------------------
    | CANCELLED SALES
    |--------------------------------------------------------------------------
    */

    const cancelledOrderIds = new Set(
      salesArray
        .filter(
          (sale) =>
            sale.cancelled === true &&
            sale.orderId,
        )
        .map((sale) => String(sale.orderId)),
    );

    /*
    |--------------------------------------------------------------------------
    | CASH
    |--------------------------------------------------------------------------
    */

    const cashTransactions = Array.isArray(cash.transactions)
      ? cash.transactions
      : [];

    const filteredCashTransactions = cashTransactions.filter(
      (transaction) => {
        const date = getDate(
          transaction.createdAt ||
            transaction.date ||
            transaction.updatedAt,
        );

        return isDateInRange(
          date,
          range.from,
          range.to,
        );
      },
    );

    /*
    |--------------------------------------------------------------------------
    | КАССОВЫЕ ПОКАЗАТЕЛИ
    |--------------------------------------------------------------------------
    */

    let cashSales = 0;

    let cashReservations = 0;

    let cancelledReservationDeposits = 0;

    let cashExpenses = 0;

    let cashReturns = 0;

    let supplierPayments = 0;

    let deposits = 0;

    let withdraws = 0;

    const operationTypes = {};

    filteredCashTransactions.forEach((transaction) => {
      const type = transaction.type || "unknown";

      const amount = toNumber(transaction.amount);

      /*
      |--------------------------------------------------------------------------
      | ОТМЕНЁННАЯ ПРОДАЖА
      |--------------------------------------------------------------------------
      */

      if (
        type === "sale" &&
        transaction.orderId &&
        cancelledOrderIds.has(
          String(transaction.orderId),
        )
      ) {
        return;
      }

      /*
      |--------------------------------------------------------------------------
      | БРОНИРОВАНИЕ
      |--------------------------------------------------------------------------
      */

      if (type === "reservation") {
        const reservationId =
          getReservationIdFromTransaction(transaction);

        /*
        | Если кассовая транзакция напрямую связана
        | с отменённой бронью — НЕ считаем её приходом.
        */
        if (
          reservationId &&
          cancelledReservationIds.has(
            String(reservationId),
          )
        ) {
          /*
          | Сохраняем отдельно для правильного netCashFlow.
          |
          | Например:
          | deposit 500
          | refund 500
          |
          | Приход = 0
          | Возврат = 500
          | Но реальный денежный поток = 0.
          */
          if (amount > 0) {
            cancelledReservationDeposits += Math.abs(amount);
          }

          return;
        }

        /*
        | Обычная действующая бронь
        */
        operationTypes[type] =
          (operationTypes[type] || 0) +
          Math.abs(amount);

        cashReservations += Math.max(amount, 0);

        return;
      }

      /*
      |--------------------------------------------------------------------------
      | ОСТАЛЬНЫЕ ОПЕРАЦИИ
      |--------------------------------------------------------------------------
      */

      operationTypes[type] =
        (operationTypes[type] || 0) +
        Math.abs(amount);

      switch (type) {
        case "sale":
          cashSales += Math.max(amount, 0);
          break;

        case "Rashod":
        case "expense":
          cashExpenses += Math.abs(amount);
          break;

        case "return":
          cashReturns += Math.abs(amount);
          break;

        case "buyFromPostavshik":
          supplierPayments += Math.abs(amount);
          break;

        case "deposit":
          deposits += Math.abs(amount);
          break;

        case "withdraw":
          withdraws += Math.abs(amount);
          break;

        default:
          break;
      }
    });

    /*
    |--------------------------------------------------------------------------
    | EXPENSES
    |--------------------------------------------------------------------------
    */

    const expensesArray = Array.isArray(expenses)
      ? expenses
      : [];

    const filteredExpenses = expensesArray.filter(
      (expense) => {
        const date = getDate(
          expense.createdAt ||
            expense.date ||
            expense.updatedAt,
        );

        return isDateInRange(
          date,
          range.from,
          range.to,
        );
      },
    );

    const expenseCategories = {};

    let totalExpenses = 0;

    filteredExpenses.forEach((expense) => {
      const amount = Math.abs(
        toNumber(expense.amount),
      );

      const category =
        expense.category || "Без категории";

      totalExpenses += amount;

      expenseCategories[category] =
        (expenseCategories[category] || 0) +
        amount;
    });

    /*
    |--------------------------------------------------------------------------
    | SALES
    |--------------------------------------------------------------------------
    */

    const filteredSales = salesArray.filter((sale) => {
      /*
      | Отменённые продажи полностью исключаем.
      */
      if (sale.cancelled === true) {
        return false;
      }

      const date = getDate(
        sale.createdAt ||
          sale.date ||
          sale.updatedAt,
      );

      return isDateInRange(
        date,
        range.from,
        range.to,
      );
    });

    const cashSaleTransactions =
      filteredCashTransactions.filter(
        (transaction) => {
          if (transaction.type !== "sale") {
            return false;
          }

          if (
            transaction.orderId &&
            cancelledOrderIds.has(
              String(transaction.orderId),
            )
          ) {
            return false;
          }

          return true;
        },
      );

    let salesTotal = 0;

    let salesCount = 0;

    const salesByPayment = {
      cash: 0,
      card: 0,
      amanat: 0,
      mplus: 0,
      local: 0,
      online_qr: 0,
    };

    /*
    |--------------------------------------------------------------------------
    | Продажи из sales.json
    |--------------------------------------------------------------------------
    */

    if (filteredSales.length > 0) {
      salesCount = filteredSales.length;

      filteredSales.forEach((sale) => {
        const total = Math.abs(
          toNumber(
            sale.totalSom ??
              sale.total ??
              sale.sum ??
              sale.amount,
          ),
        );

        salesTotal += total;

        addPaymentToSummary(
          salesByPayment,
          sale,
          total,
        );
      });
    }

    /*
    |--------------------------------------------------------------------------
    | Если sales.json пустой
    |--------------------------------------------------------------------------
    */

    if (filteredSales.length === 0) {
      salesCount = cashSaleTransactions.length;

      cashSaleTransactions.forEach(
        (transaction) => {
          const amount = Math.abs(
            toNumber(transaction.amount),
          );

          salesTotal += amount;

          addPaymentToSummary(
            salesByPayment,
            transaction,
            amount,
          );
        },
      );
    }

    /*
    |--------------------------------------------------------------------------
    | Если sales.json не содержит оплату
    |--------------------------------------------------------------------------
    */

    const paymentTotalFromSales =
      salesByPayment.cash +
      salesByPayment.card +
      salesByPayment.amanat +
      salesByPayment.mplus +
      salesByPayment.local +
      salesByPayment.online_qr;

    if (
      filteredSales.length > 0 &&
      paymentTotalFromSales === 0 &&
      cashSaleTransactions.length > 0
    ) {
      salesByPayment.cash = 0;
      salesByPayment.card = 0;
      salesByPayment.amanat = 0;
      salesByPayment.mplus = 0;
      salesByPayment.local = 0;
      salesByPayment.online_qr = 0;

      cashSaleTransactions.forEach(
        (transaction) => {
          const amount = Math.abs(
            toNumber(transaction.amount),
          );

          addPaymentToSummary(
            salesByPayment,
            transaction,
            amount,
          );
        },
      );
    }

    /*
    |--------------------------------------------------------------------------
    | RESERVATIONS
    |--------------------------------------------------------------------------
    */

    const filteredReservations =
      activeReservations.filter(
        (reservation) => {
          const date = getDate(
            reservation.createdAt ||
              reservation.date ||
              reservation.updatedAt,
          );

          return isDateInRange(
            date,
            range.from,
            range.to,
          );
        },
      );

    let reservationsTotal = 0;

    filteredReservations.forEach(
      (reservation) => {
        reservationsTotal += Math.abs(
          toNumber(
            reservation.total ??
              reservation.totalAmount ??
              reservation.amount,
          ),
        );
      },
    );

    /*
    |--------------------------------------------------------------------------
    | PURCHASES
    |--------------------------------------------------------------------------
    */

    const purchasesArray = Array.isArray(purchases)
      ? purchases
      : [];

    const filteredPurchases =
      purchasesArray.filter((purchase) => {
        const date = getDate(
          purchase.createdAt ||
            purchase.date ||
            purchase.updatedAt,
        );

        return isDateInRange(
          date,
          range.from,
          range.to,
        );
      });

    let purchasesTotal = 0;

    filteredPurchases.forEach(
      (purchase) => {
        purchasesTotal += Math.abs(
          toNumber(
            purchase.total ??
              purchase.sum ??
              purchase.amount,
          ),
        );
      },
    );

    /*
    |--------------------------------------------------------------------------
    | RETURNS
    |--------------------------------------------------------------------------
    */

    const returnsArray = Array.isArray(returns)
      ? returns
      : [];

    const filteredReturns = returnsArray.filter(
      (item) => {
        const date = getDate(
          item.createdAt ||
            item.date ||
            item.updatedAt,
        );

        return isDateInRange(
          date,
          range.from,
          range.to,
        );
      },
    );

    let returnsTotal = 0;

    filteredReturns.forEach((item) => {
      returnsTotal += Math.abs(
        toNumber(
          item.total ??
            item.amount ??
            item.sum,
        ),
      );
    });

    /*
    |--------------------------------------------------------------------------
    | ДНИ
    |--------------------------------------------------------------------------
    */

    const dailyMap = {};

    filteredCashTransactions.forEach(
      (transaction) => {
        /*
        | Отменённая продажа
        */
        if (
          transaction.type === "sale" &&
          transaction.orderId &&
          cancelledOrderIds.has(
            String(transaction.orderId),
          )
        ) {
          return;
        }

        const date = getDate(
          transaction.createdAt ||
            transaction.date ||
            transaction.updatedAt,
        );

        const day = getDayKey(date);

        if (!day) {
          return;
        }

        if (!dailyMap[day]) {
          dailyMap[day] = emptyDay();
        }

        const amount = Math.abs(
          toNumber(transaction.amount),
        );

        /*
        |--------------------------------------------------------------------------
        | Отменённая бронь
        |--------------------------------------------------------------------------
        */

        if (transaction.type === "reservation") {
          const reservationId =
            getReservationIdFromTransaction(
              transaction,
            );

          if (
            reservationId &&
            cancelledReservationIds.has(
              String(reservationId),
            )
          ) {
            /*
            | Не показываем отменённую бронь
            | в приходе за день.
            |
            | Но для net добавляем её обратно,
            | потому что ниже refund будет вычтен.
            */
            dailyMap[day].net += amount;

            return;
          }

          dailyMap[day].reservations += amount;
        }

        /*
        |--------------------------------------------------------------------------
        | Остальные операции
        |--------------------------------------------------------------------------
        */

        switch (transaction.type) {
          case "sale":
            dailyMap[day].sales += amount;
            break;

          case "Rashod":
          case "expense":
            dailyMap[day].expenses += amount;
            break;

          case "return":
            dailyMap[day].returns += amount;
            break;

          case "buyFromPostavshik":
            dailyMap[day].supplierPayments += amount;
            break;

          case "deposit":
            dailyMap[day].deposits += amount;
            break;

          case "withdraw":
            dailyMap[day].withdraws += amount;
            break;

          default:
            break;
        }

        /*
        |--------------------------------------------------------------------------
        | NET
        |--------------------------------------------------------------------------
        */

        dailyMap[day].net =
          dailyMap[day].sales +
          dailyMap[day].reservations +
          dailyMap[day].deposits -
          dailyMap[day].expenses -
          dailyMap[day].returns -
          dailyMap[day].supplierPayments -
          dailyMap[day].withdraws;

        /*
        | Важно:
        | если была отменённая бронь,
        | её депозит добавляется отдельно в net.
        */
        if (
          transaction.type === "reservation"
        ) {
          const reservationId =
            getReservationIdFromTransaction(
              transaction,
            );

          if (
            reservationId &&
            cancelledReservationIds.has(
              String(reservationId),
            )
          ) {
            dailyMap[day].net += amount;
          }
        }
      },
    );

    const daily = Object.entries(dailyMap)
      .sort(([a], [b]) =>
        a.localeCompare(b),
      )
      .map(([date, values]) => ({
        date,
        ...values,
      }));

    /*
    |--------------------------------------------------------------------------
    | ОБЩИЕ ПОКАЗАТЕЛИ
    |--------------------------------------------------------------------------
    */

    /*
    | Приход:
    |
    | Продажи
    | +
    | только действующие брони
    |
    | Отменённые брони сюда НЕ входят.
    */
    const income =
      cashSales +
      cashReservations;

    const outgoing =
      cashExpenses +
      cashReturns +
      supplierPayments;

    /*
    | Для netCashFlow учитываем реальные деньги.
    |
    | Если было:
    | отменённая бронь +500
    | возврат -500
    |
    | итог = 0.
    */
    const netCashFlow =
      income +
      cancelledReservationDeposits -
      outgoing;

    /*
    |--------------------------------------------------------------------------
    | ВСЕ ОПЕРАЦИИ
    |--------------------------------------------------------------------------
    */

    const transactions =
      filteredCashTransactions
        .map((transaction) => ({
          id: transaction.id,

          type: transaction.type,

          amount: toNumber(
            transaction.amount,
          ),

          responsible:
            transaction.responsible || "",

          comment:
            transaction.comment || "",

          category:
            transaction.category || "",

          reservationId:
            transaction.reservationId ||
            transaction.bookingId ||
            transaction.reservation?.id ||
            "",

          createdAt:
            transaction.createdAt ||
            transaction.date ||
            transaction.updatedAt,
        }))
        .sort(
          (a, b) =>
            new Date(b.createdAt) -
            new Date(a.createdAt),
        );

    /*
    |--------------------------------------------------------------------------
    | DEBUG
    |--------------------------------------------------------------------------
    */

    console.log("REPORT SALES:", {
      period: {
        from,
        to,
      },

      salesFromSalesJson:
        filteredSales.length,

      salesFromCashJson:
        cashSaleTransactions.length,

      salesTotal,

      salesCount,

      salesByPayment,

      reservationsTotal,

      activeReservations:
        filteredReservations.length,

      cancelledReservations:
        reservationsArray.length -
        activeReservations.length,

      cashReservations,

      cancelledReservationDeposits,

      income,

      netCashFlow,
    });

    /*
    |--------------------------------------------------------------------------
    | ОТВЕТ
    |--------------------------------------------------------------------------
    */

    res.json({
      success: true,

      period: {
        from: from || null,
        to: to || null,
      },

      balance: toNumber(cash.balance),

      summary: {
        /*
        | Только продажи + действующие брони.
        | Отменённые брони здесь НЕ учитываются.
        */
        income,

        expenses: totalExpenses,

        cashExpenses,

        supplierPayments,

        returns: cashReturns,

        deposits,

        withdraws,

        sales: salesTotal,

        salesCount,

        /*
        | Только действующие брони.
        */
        reservations: reservationsTotal,

        reservationsCount:
          filteredReservations.length,

        purchases: purchasesTotal,

        purchasesCount:
          filteredPurchases.length,

        returnsTotal,

        returnsCount:
          filteredReturns.length,

        netCashFlow,
      },

      salesByPayment,

      expensesByCategory:
        Object.entries(expenseCategories)
          .map(([name, value]) => ({
            name,
            value,
          }))
          .sort(
            (a, b) => b.value - a.value,
          ),

      operationTypes:
        Object.entries(operationTypes)
          .map(([name, value]) => ({
            name,
            value,
          }))
          .sort(
            (a, b) => b.value - a.value,
          ),

      daily,

      transactions,

      files: {
        cash: cashTransactions.length,

        expenses: expensesArray.length,

        sales: salesArray.length,

        reservations:
          reservationsArray.length,

        purchases:
          purchasesArray.length,

        transfers: Array.isArray(transfers)
          ? transfers.length
          : 0,

        returns: returnsArray.length,
      },
    });
  } catch (error) {
    console.error(
      "REPORT ERROR:",
      error,
    );

    res.status(500).json({
      success: false,

      message:
        "Не удалось сформировать отчёт",

      error: error.message,
    });
  }
});

/*
|--------------------------------------------------------------------------
| ROUTE: SEND REPORT TO TELEGRAM
|--------------------------------------------------------------------------
| POST /api/reports/send-telegram
|--------------------------------------------------------------------------
*/

router.post(
  "/send-telegram",
  upload.single("file"),
  async (req, res) => {
    try {
      const botToken =
        process.env.TELEGRAM_BOT_TOKEN;

      const chatId =
        process.env.TELEGRAM_CHAT_ID;

      if (!botToken) {
        return res.status(500).json({
          success: false,

          message:
            "TELEGRAM_BOT_TOKEN не настроен",
        });
      }

      if (!chatId) {
        return res.status(500).json({
          success: false,

          message:
            "TELEGRAM_CHAT_ID не настроен",
        });
      }

      if (!req.file) {
        return res.status(400).json({
          success: false,

          message:
            "PDF-файл не передан",
        });
      }

      const caption =
        req.body?.caption ||
        `Отчёт кассы\n${new Date().toLocaleString(
          "ru-RU",
        )}`;

      const formData = new FormData();

      formData.append(
        "chat_id",
        chatId,
      );

      formData.append(
        "caption",
        caption,
      );

      const blob = new Blob(
        [req.file.buffer],
        {
          type:
            req.file.mimetype ||
            "application/pdf",
        },
      );

      formData.append(
        "document",
        blob,
        req.file.originalname ||
          "report.pdf",
      );

      const telegramResponse =
        await fetch(
          `https://api.telegram.org/bot${botToken}/sendDocument`,
          {
            method: "POST",
            body: formData,
          },
        );

      const telegramData =
        await telegramResponse.json();

      if (
        !telegramResponse.ok ||
        !telegramData.ok
      ) {
        console.error(
          "TELEGRAM ERROR:",
          telegramData,
        );

        return res.status(500).json({
          success: false,

          message:
            telegramData.description ||
            "Telegram не принял файл",
        });
      }

      res.json({
        success: true,

        message:
          "Отчёт отправлен в Telegram",
      });
    } catch (error) {
      console.error(
        "SEND TELEGRAM REPORT ERROR:",
        error,
      );

      res.status(500).json({
        success: false,

        message:
          "Не удалось отправить отчёт в Telegram",

        error: error.message,
      });
    }
  },
);

/*
|--------------------------------------------------------------------------
| ROUTE: CLEAR ALL DATA
|--------------------------------------------------------------------------
| DELETE /api/reports/clear
|--------------------------------------------------------------------------
*/

router.delete(
  "/clear",
  async (req, res) => {
    try {
      const files = [
        "cash.json",
        "expenses.json",
        "sales.json",
        "reservations.json",
        "purchases.json",
        "transfers.json",
        "returns.json",
      ];

      const emptyData = {
        "cash.json": {
          balance: 0,
          transactions: [],
        },

        "expenses.json": [],

        "sales.json": [],

        "reservations.json": [],

        "purchases.json": [],

        "transfers.json": [],

        "returns.json": [],
      };

      for (const fileName of files) {
        const filePath = path.join(
          DATA_DIR,
          fileName,
        );

        await fs.writeFile(
          filePath,
          JSON.stringify(
            emptyData[fileName],
            null,
            2,
          ),
          "utf8",
        );
      }

      console.log(
        "ВСЕ JSON-ДАННЫЕ ОЧИЩЕНЫ",
      );

      res.json({
        success: true,

        message:
          "Все данные успешно очищены",

        files,
      });
    } catch (error) {
      console.error(
        "CLEAR DATA ERROR:",
        error,
      );

      res.status(500).json({
        success: false,

        message:
          "Не удалось очистить данные",

        error: error.message,
      });
    }
  },
);

module.exports = router;