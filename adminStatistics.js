
const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const router = express.Router();

const DATA_DIR = path.join(__dirname, "..", "data");

const BRANCHES = ["bishkek", "dordoy", "osh"];

const BRANCH_NAMES = {
  bishkek: "Бишкек",
  dordoy: "Дордой",
  osh: "Ош",
};

const TOKEN_TTL_SECONDS = 8 * 60 * 60;

const FILES = {
  sales: path.join(DATA_DIR, "sales.json"),
  expenses: path.join(DATA_DIR, "expenses.json"),
  returns: path.join(DATA_DIR, "returns.json"),
  cash: path.join(DATA_DIR, "cash.json"),
  transfers: path.join(DATA_DIR, "transfers.json"),
  incoming: path.join(DATA_DIR, "incoming.json"),
  stock: path.join(DATA_DIR, "stock.json"),
};

async function readJson(file, fallback = {}) {
  try {
    const content = await fs.readFile(file, "utf8");
    return JSON.parse(content);
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    console.error(`Ошибка чтения ${file}:`, error.message);
    return fallback;
  }
}

function getBranchValue(data, branch) {
  if (!data || typeof data !== "object") return [];

  if (Array.isArray(data)) {
    return data.filter(
      (item) => !item.branch || item.branch === branch
    );
  }

  const value = data[branch];

  if (Array.isArray(value)) return value;

  if (value && typeof value === "object") {
    return value;
  }

  return [];
}

function flattenRecords(value) {
  if (Array.isArray(value)) return value;

  if (!value || typeof value !== "object") return [];

  return Object.entries(value).flatMap(([key, item]) => {
    if (Array.isArray(item)) {
      return item.map((record) => ({
        ...record,
        __reportDate: record.createdAt || record.date || key,
      }));
    }

    if (item && typeof item === "object") {
      return [{
        ...item,
        __reportDate: item.createdAt || item.date || key,
      }];
    }

    return [];
  });
}

function getRecordDate(record, fallbackDate) {
  const raw =
    record?.createdAt ||
    record?.date ||
    record?.receivedAt ||
    record?.updatedAt ||
    record?.__reportDate ||
    fallbackDate;

  if (!raw) return "";

  const value = String(raw);

  // Для ISO-дат сохраняем исходный день, не сдвигая его через UTC.
  const isoMatch = value.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoMatch) return isoMatch[1];

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function isWithinPeriod(record, from, to) {
  const date = getRecordDate(record);

  if (!date) return false;
  if (from && date < from) return false;
  if (to && date > to) return false;

  return true;
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function getSaleAmount(sale) {
  if (sale?.totalSom != null) {
    return toNumber(sale.totalSom);
  }

  if (sale?.totalKopecks != null) {
    return toNumber(sale.totalKopecks) / 100;
  }

  if (sale?.total != null) {
    return toNumber(sale.total);
  }

  return 0;
}

function getExpenseAmount(expense) {
  if (expense?.amount != null) return toNumber(expense.amount);
  if (expense?.totalSom != null) return toNumber(expense.totalSom);
  if (expense?.total != null) return toNumber(expense.total);
  return 0;
}

function getReturnAmount(record) {
  if (record?.total != null) return toNumber(record.total);
  if (record?.totalSom != null) return toNumber(record.totalSom);
  if (record?.amount != null) return toNumber(record.amount);
  return 0;
}

function getSalesForBranch(data, branch) {
  const branchData = getBranchValue(data, branch);
  return flattenRecords(branchData).map((sale) => ({
    ...sale,
    __reportDate: getRecordDate(sale, sale.__reportDate),
  }));
}

function getBranchRecords(data, branch) {
  return flattenRecords(getBranchValue(data, branch));
}

function getItemAmount(item) {
  if (item?.totalSom != null) return toNumber(item.totalSom);
  if (item?.totalKopecks != null) {
    return toNumber(item.totalKopecks) / 100;
  }
  if (item?.sum != null) return toNumber(item.sum);

  return toNumber(item?.priceSom ?? item?.price) *
    toNumber(item?.quantity);
}

function getItemQuantity(item) {
  return toNumber(item?.quantity ?? item?.count);
}

function getSellerName(sale) {
  const salesperson = sale?.salesperson;

  if (typeof salesperson === "string") {
    return salesperson.trim() || "Не указан";
  }

  return (
    salesperson?.name ||
    sale?.salespersonName ||
    sale?.sellerName ||
    "Не указан"
  );
}

function getItemKey(item) {
  return String(
    item?.id ||
    item?.assortmentId ||
    item?.article ||
    item?.code ||
    item?.name ||
    "unknown"
  );
}

function isCancelled(sale) {
  return (
    sale?.cancelled === true ||
    sale?.isCancelled === true ||
    sale?.status === "cancelled" ||
    sale?.status === "canceled"
  );
}

function buildBranchReport({
  branch,
  from,
  to,
  salesData,
  expensesData,
  returnsData,
  cashData,
  transfersData,
  incomingData,
  stockData,
}) {
  const allSales = getSalesForBranch(salesData, branch);

  const periodSales = allSales.filter((sale) =>
    isWithinPeriod(sale, from, to)
  );

  const cancelledSales = periodSales.filter(isCancelled);
  const completedSales = periodSales.filter((sale) => !isCancelled(sale));

  const expenses = getBranchRecords(expensesData, branch)
    .filter((record) => isWithinPeriod(record, from, to));

  const returns = getBranchRecords(returnsData, branch)
    .filter((record) => isWithinPeriod(record, from, to));

  const cashBranch = getBranchValue(cashData, branch);
  const cashTransactions = Array.isArray(cashBranch)
    ? cashBranch
    : Array.isArray(cashBranch?.transactions)
      ? cashBranch.transactions
      : [];

  const revenue = completedSales.reduce(
    (sum, sale) => sum + getSaleAmount(sale),
    0
  );

  const cancelledAmount = cancelledSales.reduce(
    (sum, sale) => sum + getSaleAmount(sale),
    0
  );

  const expensesTotal = expenses.reduce(
    (sum, record) => sum + getExpenseAmount(record),
    0
  );

  const returnsTotal = returns.reduce(
    (sum, record) => sum + getReturnAmount(record),
    0
  );

  const soldProducts = new Map();
  const sellersMap = new Map();
  const trendMap = new Map();

  let soldQuantity = 0;
  let soldProductsAmount = 0;

  for (const sale of completedSales) {
    const saleDate = getRecordDate(sale, sale.__reportDate);
    const saleAmount = getSaleAmount(sale);

    trendMap.set(
      saleDate,
      (trendMap.get(saleDate) || 0) + saleAmount
    );

    const sellerName = getSellerName(sale);
    const seller = sellersMap.get(sellerName) || {
      name: sellerName,
      salesCount: 0,
      amount: 0,
    };

    seller.salesCount += 1;
    seller.amount += saleAmount;
    sellersMap.set(sellerName, seller);

    for (const item of Array.isArray(sale.items) ? sale.items : []) {
      const key = getItemKey(item);
      const quantity = getItemQuantity(item);
      const amount = getItemAmount(item);

      const product = soldProducts.get(key) || {
        id: key,
        name: item.name || "Без названия",
        article: item.article || item.code || "",
        quantity: 0,
        amount: 0,
      };

      product.quantity += quantity;
      product.amount += amount;

      soldProducts.set(key, product);
      soldQuantity += quantity;
      soldProductsAmount += amount;
    }
  }

  const trend = [...trendMap.entries()]
    .map(([date, amount]) => ({ date, amount }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const topSellers = [...sellersMap.values()]
    .sort((a, b) => b.amount - a.amount);

  const products = [...soldProducts.values()]
    .sort((a, b) => b.quantity - a.quantity);

  const cashBalance = Array.isArray(cashBranch)
    ? 0
    : toNumber(cashBranch?.balance);

  const cashFlow = cashTransactions
    .filter((record) => isWithinPeriod(record, from, to))
    .reduce((sum, record) => sum + toNumber(record.amount), 0);

  // Поступления и остатки подключаются только из существующих источников.
  const transferRecords = getBranchRecords(transfersData, branch)
    .filter((record) => isWithinPeriod(record, from, to));

  const incomingRecords = getBranchRecords(incomingData, branch)
    .filter((record) => isWithinPeriod(record, from, to));

  const incoming = [...transferRecords, ...incomingRecords]
    .filter((record) => {
      const type = String(
        record.type || record.operation || record.kind || ""
      ).toLowerCase();

      return (
        record.direction === "incoming" ||
        type.includes("incoming") ||
        type.includes("приход") ||
        type.includes("receipt") ||
        type.includes("supply")
      );
    });

  const incomingTotal = incoming.reduce((sum, record) => {
    return sum + toNumber(
      record.totalSom ?? record.total ?? record.amount ?? 0
    );
  }, 0);

  const stockBranch = getBranchValue(stockData, branch);
  const hasStockSource =
    Array.isArray(stockBranch) ||
    (stockBranch && typeof stockBranch === "object" &&
      Object.keys(stockBranch).length > 0);

  const stockItems = flattenRecords(stockBranch);
  const stockQuantity = stockItems.reduce(
    (sum, item) => sum + toNumber(item.stock ?? item.quantity ?? item.quantityStock),
    0
  );

  return {
    branch,
    branchName: BRANCH_NAMES[branch],
    salesCount: completedSales.length,
    cancelledSalesCount: cancelledSales.length,
    revenue,
    cancelledAmount,
    returns: returnsTotal,
    returnsCount: returns.length,
    expenses: expensesTotal,

    // По текущему требованию: продажи минус расходы.
    afterReturnsAndExpenses: revenue - expensesTotal,

    cashFlow,
    currentCashBalance: cashBalance,
    soldQuantity,
    soldProductsAmount,
    products,
    sellers: topSellers,
    trend,
    incomingCount: incoming.length,
    incomingTotal,
    stockQuantity: hasStockSource ? stockQuantity : null,
    hasStockSource,
  };
}

function aggregateReports(reports) {
  const fields = [
    "salesCount",
    "cancelledSalesCount",
    "revenue",
    "cancelledAmount",
    "returns",
    "returnsCount",
    "expenses",
    "afterReturnsAndExpenses",
    "cashFlow",
    "currentCashBalance",
    "soldQuantity",
    "soldProductsAmount",
    "incomingCount",
    "incomingTotal",
  ];

  const summary = {};

  for (const field of fields) {
    summary[field] = reports.reduce(
      (sum, report) => sum + toNumber(report[field]),
      0
    );
  }

  const reportsWithStock = reports.filter(
    (report) => report.hasStockSource
  );

  summary.stockQuantity = reportsWithStock.length
    ? reportsWithStock.reduce(
        (sum, report) => sum + toNumber(report.stockQuantity),
        0
      )
    : null;

  summary.hasStockSource = reportsWithStock.length > 0;

  return summary;
}

function getSecret() {
  return process.env.ADMIN_STATS_SECRET || "";
}

function createToken() {
  const secret = getSecret();

  if (!secret) {
    throw new Error("Не задан ADMIN_STATS_SECRET");
  }

  const payload = Buffer.from(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
  })).toString("base64url");

  const signature = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");

  return `${payload}.${signature}`;
}

function verifyToken(token) {
  if (!token || !getSecret()) return false;

  const parts = token.split(".");
  if (parts.length !== 2) return false;

  const [payload, signature] = parts;

  const expected = crypto
    .createHmac("sha256", getSecret())
    .update(payload)
    .digest();

  let received;

  try {
    received = Buffer.from(signature, "base64url");
  } catch {
    return false;
  }

  if (
    received.length !== expected.length ||
    !crypto.timingSafeEqual(received, expected)
  ) {
    return false;
  }

  try {
    const data = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8")
    );

    return Number(data.exp) > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

router.post("/auth", express.json(), (req, res) => {
  const password = process.env.ADMIN_STATS_PASSWORD;

  if (!password || !getSecret()) {
    return res.status(500).json({
      success: false,
      message: "Настрой ADMIN_STATS_PASSWORD и ADMIN_STATS_SECRET на сервере",
    });
  }

  if (req.body?.password !== password) {
    return res.status(401).json({
      success: false,
      message: "Неверный пароль",
    });
  }

  try {
    return res.json({
      success: true,
      token: createToken(),
      expiresIn: TOKEN_TTL_SECONDS,
    });
  } catch (error) {
    console.error("Ошибка создания токена статистики:", error);
    return res.status(500).json({
      success: false,
      message: "Не удалось создать токен",
    });
  }
});

router.get("/", async (req, res) => {
  const token = req.get("x-admin-stats-token");

  if (!verifyToken(token)) {
    return res.status(401).json({
      success: false,
      message: "Требуется авторизация администратора",
    });
  }

  const from = String(req.query.from || "");
  const to = String(req.query.to || "");
  const requestedBranch = String(req.query.branch || "all");

  const validDate = (value) =>
    !value || /^\d{4}-\d{2}-\d{2}$/.test(value);

  if (!validDate(from) || !validDate(to) || (from && to && from > to)) {
    return res.status(400).json({
      success: false,
      message: "Некорректный диапазон дат",
    });
  }

  if (
    requestedBranch !== "all" &&
    !BRANCHES.includes(requestedBranch)
  ) {
    return res.status(400).json({
      success: false,
      message: "Неизвестный филиал",
    });
  }

  try {
    const [
      salesData,
      expensesData,
      returnsData,
      cashData,
      transfersData,
      incomingData,
      stockData,
    ] = await Promise.all([
      readJson(FILES.sales),
      readJson(FILES.expenses),
      readJson(FILES.returns),
      readJson(FILES.cash),
      readJson(FILES.transfers),
      readJson(FILES.incoming),
      readJson(FILES.stock),
    ]);

    const reports = BRANCHES.map((branch) =>
      buildBranchReport({
        branch,
        from,
        to,
        salesData,
        expensesData,
        returnsData,
        cashData,
        transfersData,
        incomingData,
        stockData,
      })
    );

    const selectedBranches = requestedBranch === "all"
      ? reports
      : reports.filter(
          (report) => report.branch === requestedBranch
        );

    return res.json({
      success: true,
      period: { from, to },
      selectedBranch: requestedBranch,
      summary: aggregateReports(selectedBranches),
      branches: reports,
      selectedBranches,
      notes: {
        profit: "Продажи минус расходы. Возвраты и себестоимость не вычитаются.",
        incoming: "Поступления отображаются только при наличии данных в incoming.json или transfers.json.",
        stock: "Остатки отображаются только при наличии data/stock.json.",
      },
    });
  } catch (error) {
    console.error("Ошибка admin statistics:", error);

    return res.status(500).json({
      success: false,
      message: "Не удалось загрузить статистику",
    });
  }
});

module.exports = router;
