const express = require("express");
const fs = require("fs");
const path = require("path");
const { getCurrentBranch } = require("./branchContext");

const router = express.Router();

const MOYSKLAD_API = "https://api.moysklad.ru/api/remap/1.2";

const LOGIN = process.env.MOYSKLAD_LOGIN;
const PASSWORD = process.env.MOYSKLAD_PASSWORD;
const AGENT_ID = process.env.MOYSKLAD_AGENT;

// ID розничной точки / кассы.
// Для перемещений между складами НЕ используется.
const RETAIL_STORE_ID = process.env.MOYSKLAD_RETAIL_STORE_ID;

const DATA_DIR = path.join(__dirname, "..", "data");
const TRANSFERS_FILE = path.join(DATA_DIR, "transfers.json");
const CASH_FILE = path.join(DATA_DIR, "cash.json");

const BRANCH_KEYS = ["bishkek", "dordoy", "osh"];

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

/**
 * ----------------------------------------------------
 * BRANCH HELPERS
 * ----------------------------------------------------
 */

function getBranchKey(branch = getCurrentBranch()) {
  const value =
    branch?.key ||
    branch?.code ||
    branch?.slug ||
    branch?.branchKey ||
    branch?.id ||
    branch?.name;

  if (!value) {
    throw new Error("Не удалось определить текущий филиал");
  }

  const normalized = String(value).trim().toLowerCase();

  if (BRANCH_KEYS.includes(normalized)) {
    return normalized;
  }

  /**
   * Если branchContext использует русские названия,
   * поддерживаем их тоже.
   */

  if (normalized.includes("бишкек") || normalized.includes("bishkek")) {
    return "bishkek";
  }

  if (
    normalized.includes("дордой") ||
    normalized.includes("dordoy") ||
    normalized.includes("dordoi")
  ) {
    return "dordoy";
  }

  if (normalized.includes("ош") || normalized === "osh") {
    return "osh";
  }

  throw new Error(
    `Неизвестный филиал: ${value}. Ожидается bishkek, dordoy или osh.`,
  );
}

function createEmptyCashBranch() {
  return {
    balance: 0,
    transactions: [],
  };
}

function createEmptyCashStorage() {
  return {
    bishkek: createEmptyCashBranch(),
    dordoy: createEmptyCashBranch(),
    osh: createEmptyCashBranch(),
  };
}

function createEmptyTransfersStorage() {
  return {
    bishkek: [],
    dordoy: [],
    osh: [],
  };
}

/**
 * ----------------------------------------------------
 * MoySklad API
 * ----------------------------------------------------
 */

function getAuthHeader() {
  if (!LOGIN || !PASSWORD) {
    throw new Error("Не указаны MOYSKLAD_LOGIN или MOYSKLAD_PASSWORD");
  }

  const credentials = Buffer.from(`${LOGIN}:${PASSWORD}`).toString("base64");

  return `Basic ${credentials}`;
}

async function moyskladRequest(endpoint, options = {}) {
  const response = await fetch(`${MOYSKLAD_API}${endpoint}`, {
    ...options,

    headers: {
      Accept: "application/json;charset=utf-8",
      "Content-Type": "application/json",
      Authorization: getAuthHeader(),
      ...(options.headers || {}),
    },
  });

  const text = await response.text();

  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    console.error("MoySklad API error:", response.status, data);

    const message =
      data?.errors?.[0]?.error ||
      data?.message ||
      `MoySklad API error: ${response.status}`;

    throw new Error(message);
  }

  return data;
}

function getMeta(entity, id) {
  if (!id) {
    throw new Error(`Не передан ID сущности ${entity}`);
  }

  const allowedTypes = [
    "product",
    "variant",
    "bundle",
    "service",
    "store",
    "organization",
    "counterparty",
  ];

  if (!allowedTypes.includes(entity)) {
    throw new Error(`Недопустимый тип meta: ${entity}`);
  }

  return {
    meta: {
      href: `${MOYSKLAD_API}/entity/${entity}/${id}`,
      type: entity,
      mediaType: "application/json",
    },
  };
}

async function getMoySkladMoves() {
  const data = await moyskladRequest(
    "/entity/move?limit=100&expand=sourceStore,targetStore,positions.assortment",
  );

  return Array.isArray(data?.rows) ? data.rows : [];
}
async function createShortageLoss({
  storeId,
  organizationId,
  items,
  transferId,
}) {
  const shortageItems = items.filter(
    (item) => Number(item.shortageQuantity || 0) > 0,
  );

  if (shortageItems.length === 0) {
    return null;
  }

  const positions = shortageItems.map((item) => {
    const quantity = Number(item.shortageQuantity);

    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new Error(`Некорректная недостача для товара "${item.name}"`);
    }

    if (!item.assortmentId) {
      throw new Error(`У товара "${item.name}" отсутствует assortmentId`);
    }

    const assortmentType =
      item.assortmentMeta?.type || item.assortmentMeta?.meta?.type || "product";

    if (!["product", "variant", "bundle", "service"].includes(assortmentType)) {
      throw new Error(
        `Неподдерживаемый тип товара "${assortmentType}" для "${item.name}"`,
      );
    }

    return {
      quantity,

      reason: `Недостача при приемке перемещения ${transferId}`,

      assortment: getMeta(assortmentType, item.assortmentId),
    };
  });

  const lossData = {
    name: `SHORTAGE-${transferId}-${Date.now()}`,

    description: `Списание недостачи при приемке перемещения ${transferId}`,

    organization: getMeta("organization", organizationId),

    store: getMeta("store", storeId),

    positions: {
      rows: positions,
    },
  };

  console.log("SHORTAGE LOSS DATA:", JSON.stringify(lossData, null, 2));

  const loss = await moyskladRequest("/entity/loss", {
    method: "POST",

    body: JSON.stringify(lossData),
  });

  return {
    id: loss.id,

    href: loss.meta?.href || null,

    name: loss.name || lossData.name,
  };
}
async function createExcessSupply({
  storeId,
  organizationId,
  items,
  transferId,
}) {
  const excessItems = items.filter(
    (item) => Number(item.excessQuantity || 0) > 0,
  );

  if (excessItems.length === 0) {
    return null;
  }

  const positions = excessItems.map((item) => {
    const quantity = Number(item.excessQuantity);

    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new Error(`Некорректный излишек для товара "${item.name}"`);
    }

    if (!item.assortmentId) {
      throw new Error(`У товара "${item.name}" отсутствует assortmentId`);
    }

    const assortmentType =
      item.assortmentMeta?.type || item.assortmentMeta?.meta?.type || "product";

    if (!["product", "variant", "bundle", "service"].includes(assortmentType)) {
      throw new Error(
        `Неподдерживаемый тип товара "${assortmentType}" для "${item.name}"`,
      );
    }

    return {
      quantity,

      price: Number(item.price || 0) * 100,

      assortment: getMeta(assortmentType, item.assortmentId),
    };
  });

  const supplyData = {
    name: `EXCESS-${transferId}-${Date.now()}`,

    description: `Оприходование излишка при приемке перемещения ${transferId}`,

    organization: getMeta("organization", organizationId),

    store: getMeta("store", storeId),

    positions: {
      rows: positions,
    },
  };

  console.log("EXCESS SUPPLY DATA:", JSON.stringify(supplyData, null, 2));

  const supply = await moyskladRequest("/entity/supply", {
    method: "POST",

    body: JSON.stringify(supplyData),
  });

  return {
    id: supply.id,

    href: supply.meta?.href || null,

    name: supply.name || supplyData.name,
  };
}
/**
 * ----------------------------------------------------
 * LOCAL JSON
 * ----------------------------------------------------
 */

/**
 * TRANSFERS
 *
 * Новый формат:
 *
 * {
 *   bishkek: [],
 *   dordoy: [],
 *   osh: []
 * }
 *
 * Старый:
 *
 * []
 *
 * Старый массив автоматически переносим
 * в текущий филиал.
 */

function readTransfers() {
  try {
    if (!fs.existsSync(TRANSFERS_FILE)) {
      const empty = createEmptyTransfersStorage();

      fs.writeFileSync(TRANSFERS_FILE, JSON.stringify(empty, null, 2), "utf8");

      return empty;
    }

    const content = fs.readFileSync(TRANSFERS_FILE, "utf8");

    if (!content.trim()) {
      const empty = createEmptyTransfersStorage();

      fs.writeFileSync(TRANSFERS_FILE, JSON.stringify(empty, null, 2), "utf8");

      return empty;
    }

    const parsed = JSON.parse(content);

    /**
     * Уже новый формат.
     */
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      BRANCH_KEYS.some((key) =>
        Object.prototype.hasOwnProperty.call(parsed, key),
      )
    ) {
      const result = createEmptyTransfersStorage();

      for (const key of BRANCH_KEYS) {
        result[key] = Array.isArray(parsed[key]) ? parsed[key] : [];
      }

      return result;
    }

    /**
     * Старый формат [].
     *
     * Переносим записи в текущий филиал.
     */
    if (Array.isArray(parsed)) {
      const branchKey = getBranchKey();

      const migrated = createEmptyTransfersStorage();

      migrated[branchKey] = parsed;

      writeTransfers(migrated);

      return migrated;
    }

    throw new Error("Неверный формат transfers.json");
  } catch (error) {
    console.error("Ошибка чтения transfers.json:", error);

    return createEmptyTransfersStorage();
  }
}

function writeTransfers(data) {
  const normalized = createEmptyTransfersStorage();

  for (const key of BRANCH_KEYS) {
    normalized[key] = Array.isArray(data?.[key]) ? data[key] : [];
  }

  fs.writeFileSync(TRANSFERS_FILE, JSON.stringify(normalized, null, 2), "utf8");
}

/**
 * CASH
 *
 * Новый формат:
 *
 * {
 *   bishkek: {
 *     balance,
 *     transactions
 *   },
 *   dordoy: {
 *     balance,
 *     transactions
 *   },
 *   osh: {
 *     balance,
 *     transactions
 *   }
 * }
 *
 * Старый формат:
 *
 * {
 *   balance,
 *   transactions
 * }
 *
 * Старый баланс переносим в текущий филиал.
 */

function readCash() {
  try {
    if (!fs.existsSync(CASH_FILE)) {
      const empty = createEmptyCashStorage();

      fs.writeFileSync(CASH_FILE, JSON.stringify(empty, null, 2), "utf8");

      return empty;
    }

    const content = fs.readFileSync(CASH_FILE, "utf8");

    if (!content.trim()) {
      const empty = createEmptyCashStorage();

      fs.writeFileSync(CASH_FILE, JSON.stringify(empty, null, 2), "utf8");

      return empty;
    }

    const parsed = JSON.parse(content);

    /**
     * Новый формат.
     */
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      BRANCH_KEYS.some((key) =>
        Object.prototype.hasOwnProperty.call(parsed, key),
      )
    ) {
      const result = createEmptyCashStorage();

      for (const key of BRANCH_KEYS) {
        const branchCash = parsed[key];

        result[key] = {
          balance: Number(branchCash?.balance || 0),

          transactions: Array.isArray(branchCash?.transactions)
            ? branchCash.transactions
            : [],
        };
      }

      return result;
    }

    /**
     * Старый формат:
     *
     * {
     *   balance,
     *   transactions
     * }
     */
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      (Object.prototype.hasOwnProperty.call(parsed, "balance") ||
        Object.prototype.hasOwnProperty.call(parsed, "transactions"))
    ) {
      const branchKey = getBranchKey();

      const migrated = createEmptyCashStorage();

      migrated[branchKey] = {
        balance: Number(parsed.balance || 0),

        transactions: Array.isArray(parsed.transactions)
          ? parsed.transactions
          : [],
      };

      writeCash(migrated);

      return migrated;
    }

    throw new Error("Неверный формат cash.json");
  } catch (error) {
    console.error("Ошибка чтения cash.json:", error);

    return createEmptyCashStorage();
  }
}

function writeCash(data) {
  const normalized = createEmptyCashStorage();

  for (const key of BRANCH_KEYS) {
    normalized[key] = {
      balance: Number(data?.[key]?.balance || 0),

      transactions: Array.isArray(data?.[key]?.transactions)
        ? data[key].transactions
        : [],
    };
  }

  fs.writeFileSync(CASH_FILE, JSON.stringify(normalized, null, 2), "utf8");
}

/**
 * ----------------------------------------------------
 * GET /api/transfers
 * ----------------------------------------------------
 *
 * Возвращает записи текущего филиала.
 */

router.get("/", (req, res) => {
  try {
    const branchKey = getBranchKey();

    const transfers = readTransfers();

    res.json({
      rows: transfers[branchKey] || [],
    });
  } catch (error) {
    console.error("GET /api/transfers:", error);

    res.status(500).json({
      message: error.message || "Не удалось загрузить перемещения",
    });
  }
});

/**
 * ----------------------------------------------------
 * GET /api/transfers/warehouses
 * ----------------------------------------------------
 */

router.get("/warehouses", async (req, res) => {
  try {
    const data = await moyskladRequest("/entity/store?limit=100");

    const rows = (data.rows || []).map((store) => ({
      id: store.id,
      name: store.name,
      code: store.code || null,
      pathName: store.pathName || "",
    }));

    res.json({
      rows,
    });
  } catch (error) {
    console.error("GET /api/transfers/warehouses:", error);

    res.status(500).json({
      message: error.message || "Не удалось загрузить склады",
    });
  }
});

/**
 * ----------------------------------------------------
 * GET /api/transfers/suppliers
 * ----------------------------------------------------
 */

router.get("/suppliers", async (req, res) => {
  try {
    const data = await moyskladRequest("/entity/counterparty?limit=100");

    const rows = (data.rows || []).map((counterparty) => ({
      id: counterparty.id,
      name: counterparty.name,
      code: counterparty.code || null,
      companyType: counterparty.companyType || null,
    }));

    res.json({
      rows,
    });
  } catch (error) {
    console.error("GET /api/transfers/suppliers:", error);

    res.status(500).json({
      message: error.message || "Не удалось загрузить поставщиков",
    });
  }
});

/**
 * ----------------------------------------------------
 * GET /api/transfers/incoming
 * ----------------------------------------------------
 *
 * Входящие перемещения должны быть видны
 * филиалу-получателю.
 *
 * Поэтому ищем по ВСЕМ филиалам,
 * а не только в текущем массиве.
 */

router.get("/incoming", async (req, res) => {
  try {
    const branch = getCurrentBranch();

    const storeId = branch.storeId;

    if (!storeId) {
      return res.status(500).json({
        message: "У текущего филиала не указан storeId",
      });
    }

    /**
     * ------------------------------------------------
     * 1. Получаем перемещения непосредственно из МойСклад
     * ------------------------------------------------
     */

    const moyskladMoves = await getMoySkladMoves();

    /**
     * ------------------------------------------------
     * 2. Получаем наши локальные перемещения
     * ------------------------------------------------
     */

    const transfersStorage = readTransfers();

    const allLocalTransfers = BRANCH_KEYS.flatMap((key) =>
      Array.isArray(transfersStorage[key]) ? transfersStorage[key] : [],
    );

    /**
     * ------------------------------------------------
     * 3. Сегодняшняя дата по Бишкеку
     * ------------------------------------------------
     */

    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Bishkek",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());

    /**
     * ------------------------------------------------
     * 4. Находим перемещения МойСклад,
     *    которые идут НА текущий склад
     * ------------------------------------------------
     */

    const incomingMoySklad = moyskladMoves.filter((move) => {
      const targetStoreId =
        move.targetStore?.id || move.targetStore?.meta?.href?.split("/").pop();

      if (targetStoreId !== storeId) {
        return false;
      }

      const createdDate = move.created
        ? new Intl.DateTimeFormat("en-CA", {
            timeZone: "Asia/Bishkek",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          }).format(new Date(move.created))
        : null;

      return createdDate === today;
    });

    /**
     * ------------------------------------------------
     * 5. Превращаем перемещения МойСклад
     *    в формат нашего POS
     * ------------------------------------------------
     */

    const importedTransfers = [];

    for (const move of incomingMoySklad) {
      /**
       * Если это перемещение уже есть
       * в нашем transfers.json,
       * повторно его не создаём.
       */

      const existing = allLocalTransfers.find(
        (item) => item.moyskladId === move.id,
      );

      if (existing) {
        continue;
      }

      const sourceStoreId =
        move.sourceStore?.id || move.sourceStore?.meta?.href?.split("/").pop();

      const targetStoreId =
        move.targetStore?.id || move.targetStore?.meta?.href?.split("/").pop();

      /**
       * ------------------------------------------------
       * Получаем позиции
       * ------------------------------------------------
       */

      const positions = move.positions?.rows || [];

      const items = positions.map((position) => {
        const assortment = position.assortment;

        const assortmentId =
          assortment?.id || assortment?.meta?.href?.split("/").pop();

        return {
          assortmentId,

          name: assortment?.name || assortment?.displayName || "Без названия",

          quantity: Number(position.quantity || 0),
          assortmentMeta: assortment?.meta || null,
          price: Number(position.price || 0) / 100,

          receivedQuantity: null,

          shortageQuantity: null,
        };
      });

      /**
       * ------------------------------------------------
       * Создаём локальную запись
       * ------------------------------------------------
       */

      const localTransfer = {
        id: `MS-${move.id}`,

        type: "transfer",

        status: "sent",

        moyskladId: move.id,

        moyskladHref: move.meta?.href || null,

        fromBranch: null,

        fromWarehouse: {
          id: sourceStoreId || null,

          name: move.sourceStore?.name || sourceStoreId || "Склад отправителя",
        },

        toWarehouse: {
          id: targetStoreId || storeId,

          name: move.targetStore?.name || branch.name || storeId,
        },

        items,

        createdAt: move.created || new Date().toISOString(),

        receivedAt: null,
      };

      importedTransfers.push(localTransfer);
    }

    /**
     * ------------------------------------------------
     * 6. Сохраняем найденные перемещения
     *    в текущий филиал
     * ------------------------------------------------
     */

    if (importedTransfers.length > 0) {
      const branchKey = getBranchKey(branch);

      if (!Array.isArray(transfersStorage[branchKey])) {
        transfersStorage[branchKey] = [];
      }

      transfersStorage[branchKey].push(...importedTransfers);

      writeTransfers(transfersStorage);
    }

    /**
     * ------------------------------------------------
     * 7. После синхронизации снова читаем storage
     * ------------------------------------------------
     */

    const updatedStorage = readTransfers();

    const allTransfers = BRANCH_KEYS.flatMap((key) =>
      Array.isArray(updatedStorage[key]) ? updatedStorage[key] : [],
    );

    /**
     * ------------------------------------------------
     * 8. Возвращаем входящие перемещения
     * ------------------------------------------------
     */

    const incoming = allTransfers
      .filter(
        (item) =>
          item.type === "transfer" &&
          item.toWarehouse?.id === storeId &&
          item.status === "sent",
      )
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    res.json({
      rows: incoming,
    });
  } catch (error) {
    console.error("GET /api/transfers/incoming:", error);

    res.status(500).json({
      message: error.message || "Не удалось загрузить входящие перемещения",
    });
  }
});

/**
 * ----------------------------------------------------
 * POST /api/transfers/outgoing
 * ----------------------------------------------------
 *
 * Филиал A -> Филиал B
 */

router.post("/outgoing", async (req, res) => {
  try {
    const { toWarehouseId, items } = req.body;

    const branch = getCurrentBranch();

    const branchKey = getBranchKey(branch);

    const fromWarehouseId = branch.storeId;

    if (!fromWarehouseId) {
      return res.status(500).json({
        message: "У текущего филиала не указан storeId",
      });
    }

    if (!toWarehouseId) {
      return res.status(400).json({
        message: "Не указан склад получателя",
      });
    }

    if (fromWarehouseId === toWarehouseId) {
      return res.status(400).json({
        message: "Склад отправителя и получателя не могут совпадать",
      });
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        message: "Добавьте хотя бы один товар",
      });
    }

    const organizations = await moyskladRequest(
      "/entity/organization?limit=100",
    );

    if (!organizations.rows || organizations.rows.length === 0) {
      throw new Error("В МойСклад не найдена организация");
    }

    const organization = organizations.rows[0];

    const positions = items.map((item) => {
      if (!item.assortmentId) {
        throw new Error(`У товара "${item.name}" отсутствует assortmentId`);
      }

      const quantity = Number(item.quantity);

      if (!Number.isFinite(quantity) || quantity <= 0) {
        throw new Error(`Некорректное количество товара "${item.name}"`);
      }

      if (!item.assortmentMeta) {
        throw new Error(`У товара "${item.name}" отсутствует assortmentMeta`);
      }

      return {
        quantity,

        assortment: {
          meta: item.assortmentMeta,
        },
      };
    });

    const moveData = {
      name: `TR-${Date.now()}`,

      description: "Перемещение между филиалами из POS",

      organization: getMeta("organization", organization.id),

      sourceStore: getMeta("store", fromWarehouseId),

      targetStore: getMeta("store", toWarehouseId),

      positions: {
        rows: positions,
      },
    };

    const moyskladMove = await moyskladRequest("/entity/move", {
      method: "POST",
      body: JSON.stringify(moveData),
    });

    const stores = await moyskladRequest("/entity/store?limit=100");

    const sourceStore = stores.rows?.find(
      (store) => store.id === fromWarehouseId,
    );

    const targetStore = stores.rows?.find(
      (store) => store.id === toWarehouseId,
    );

    const transfers = readTransfers();

    const localTransfer = {
      id: `TR-${Date.now()}`,

      type: "transfer",

      status: "sent",

      moyskladId: moyskladMove.id,

      moyskladHref: moyskladMove.meta?.href || null,

      fromBranch: branchKey,

      fromWarehouse: {
        id: fromWarehouseId,
        name: sourceStore?.name || fromWarehouseId,
      },

      toWarehouse: {
        id: toWarehouseId,
        name: targetStore?.name || toWarehouseId,
      },

      items: items.map((item) => ({
        assortmentId: item.assortmentId,

        name: item.name,

        // Сколько отправили
        quantity: Number(item.quantity),
        assortmentMeta: item.assortmentMeta || null,
        price: Number(item.price || 0),

        // Сколько реально приняли
        receivedQuantity: null,

        // Недостача
        shortageQuantity: null,
      })),

      createdAt: new Date().toISOString(),

      receivedAt: null,
    };

    if (!Array.isArray(transfers[branchKey])) {
      transfers[branchKey] = [];
    }

    transfers[branchKey].push(localTransfer);

    writeTransfers(transfers);

    res.status(201).json({
      success: true,

      transfer: localTransfer,

      moysklad: {
        id: moyskladMove.id,

        href: moyskladMove.meta?.href || null,
      },
    });
  } catch (error) {
    console.error("POST /api/transfers/outgoing:", error);

    res.status(500).json({
      message: error.message || "Не удалось создать перемещение",
    });
  }
});

/**
 * ----------------------------------------------------
 * РАСКРЫТИЕ КОМПЛЕКТА
 * ----------------------------------------------------
 */

async function expandBundle(item) {
  if (!item.assortmentId) {
    throw new Error(`У товара "${item.name}" отсутствует assortmentId`);
  }

  const quantity = Number(item.quantity);

  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new Error(`Некорректное количество товара "${item.name}"`);
  }

  const assortmentMeta = item.assortmentMeta;

  if (!assortmentMeta) {
    throw new Error(`У товара "${item.name}" отсутствует assortmentMeta`);
  }

  const assortmentType = assortmentMeta.type || assortmentMeta.meta?.type;

  console.log(`Товар "${item.name}" -> тип: ${assortmentType}`);

  /**
   * Обычный товар / модификация.
   */

  if (assortmentType !== "bundle") {
    return [
      {
        quantity,

        price: Math.round(Number(item.price || 0) * 100),

        assortment: {
          meta: assortmentMeta,
        },
      },
    ];
  }

  /**
   * Комплект.
   */

  const bundleId = assortmentMeta.href?.split("/").filter(Boolean).pop();

  if (!bundleId) {
    throw new Error(`Не удалось определить ID комплекта "${item.name}"`);
  }

  console.log(`Получаем комплект ${bundleId} из МойСклад`);

  const bundle = await moyskladRequest(`/entity/bundle/${bundleId}`);

  if (!bundle?.id) {
    throw new Error(`Комплект "${item.name}" не найден в МойСклад`);
  }

  const componentsData = await moyskladRequest(
    `/entity/bundle/${bundleId}/components?limit=100`,
  );

  const components = componentsData?.rows || [];

  console.log(
    `КОМПОНЕНТЫ КОМПЛЕКТА "${item.name}":`,
    JSON.stringify(components, null, 2),
  );

  if (components.length === 0) {
    throw new Error(`Комплект "${item.name}" не содержит компонентов`);
  }

  const bundlePrice = Number(item.price || 0);

  const totalParts = components.reduce(
    (sum, component) => sum + Number(component.quantity || 0),
    0,
  );

  const result = [];

  for (const component of components) {
    const componentQuantity = Number(component.quantity || 0);

    if (!Number.isFinite(componentQuantity) || componentQuantity <= 0) {
      continue;
    }

    const componentMeta = component.assortment?.meta;

    if (!componentMeta) {
      throw new Error(
        `У компонента комплекта "${item.name}" отсутствует assortment.meta`,
      );
    }

    if (componentMeta.type === "bundle") {
      throw new Error(
        `Комплект "${item.name}" содержит вложенный комплект. Такой комплект нужно обработать отдельно.`,
      );
    }

    const finalQuantity = componentQuantity * quantity;

    const componentPrice =
      totalParts > 0 ? bundlePrice * (componentQuantity / totalParts) : 0;

    result.push({
      quantity: finalQuantity,

      price: Math.round(componentPrice * 100),

      assortment: {
        meta: componentMeta,
      },
    });
  }

  if (result.length === 0) {
    throw new Error(`Комплект "${item.name}" не удалось раскрыть`);
  }

  console.log(
    `Комплект "${item.name}" раскрыт:`,
    JSON.stringify(result, null, 2),
  );

  return result;
}

/**
 * ----------------------------------------------------
 * POST /api/transfers/receipt
 * ----------------------------------------------------
 *
 * Приход от поставщика.
 *
 * ВАЖНЫЙ ПОРЯДОК:
 *
 * 1. Проверяем текущий филиал.
 * 2. Проверяем сумму.
 * 3. Если cash — проверяем кассу.
 * 4. Проверяем товары.
 * 5. Только после этого создаём Supply.
 * 6. После успешного Supply списываем деньги.
 * 7. Записываем локальную операцию.
 */

router.post("/receipt", async (req, res) => {
  try {
    const { supplierId, items, totalAmount, paymentMethod } = req.body;

    const branch = getCurrentBranch();

    const branchKey = getBranchKey(branch);

    const storeId = branch.storeId;

    if (!storeId) {
      return res.status(500).json({
        message: "У текущего филиала не указан storeId",
      });
    }

    if (!supplierId) {
      return res.status(400).json({
        message: "Не указан поставщик",
      });
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        message: "Добавьте хотя бы один товар",
      });
    }

    /**
     * ---------------------------------------------
     * Сумма
     * ---------------------------------------------
     */

    const purchaseAmount = Number(totalAmount || 0);

    if (!Number.isFinite(purchaseAmount) || purchaseAmount < 0) {
      return res.status(400).json({
        message: "Некорректная сумма поступления",
      });
    }

    /**
     * ---------------------------------------------
     * ПРОВЕРКА КАССЫ ДО SUPPLY
     * ---------------------------------------------
     *
     * Это самое важное исправление.
     */

    let cashStorage = null;
    let branchCash = null;

    if (paymentMethod === "cash" && purchaseAmount > 0) {
      cashStorage = readCash();

      branchCash = cashStorage[branchKey];

      if (!branchCash) {
        branchCash = createEmptyCashBranch();

        cashStorage[branchKey] = branchCash;
      }

      const currentBalance = Number(branchCash.balance || 0);

      if (currentBalance < purchaseAmount) {
        return res.status(400).json({
          message: `Недостаточно денег в кассе филиала. Баланс: ${currentBalance} сом, требуется: ${purchaseAmount} сом`,
        });
      }
    }
    /**
     * ---------------------------------------------
     * Организация
     * ---------------------------------------------
     */

    const organizations = await moyskladRequest(
      "/entity/organization?limit=100",
    );

    if (!organizations.rows || organizations.rows.length === 0) {
      throw new Error("В МойСклад не найдена организация");
    }

    const organization = organizations.rows[0];

    /**
     * ---------------------------------------------
     * Поставщик
     * ---------------------------------------------
     */

    const supplier = await moyskladRequest(
      `/entity/counterparty/${supplierId}`,
    );

    if (!supplier?.id) {
      throw new Error("Поставщик не найден в МойСклад");
    }

    /**
     * ---------------------------------------------
     * Склад
     * ---------------------------------------------
     */

    const store = await moyskladRequest(`/entity/store/${storeId}`);

    if (!store?.id) {
      throw new Error("Склад не найден в МойСклад");
    }

    /**
     * ---------------------------------------------
     * Позиции
     * ---------------------------------------------
     */

    const positions = [];

    for (const item of items) {
      const expandedPositions = await expandBundle(item);

      positions.push(...expandedPositions);
    }

    if (positions.length === 0) {
      throw new Error("После обработки товаров не осталось позиций");
    }

    /**
     * ---------------------------------------------
     * SUPPLY
     * ---------------------------------------------
     */

    const supplyData = {
      name: `SUP-${Date.now()}`,

      description: "Поступление от поставщика из POS",

      organization: {
        meta: organization.meta,
      },

      agent: {
        meta: supplier.meta,
      },

      store: {
        meta: store.meta,
      },

      positions: {
        rows: positions,
      },
    };

    console.log("SUPPLY DATA:", JSON.stringify(supplyData, null, 2));

    /**
     * ---------------------------------------------
     * СОЗДАЁМ SUPPLY
     * ---------------------------------------------
     */

    const moyskladSupply = await moyskladRequest("/entity/supply", {
      method: "POST",

      body: JSON.stringify(supplyData),
    });

    /**
     * ---------------------------------------------
     * СПИСАНИЕ ИЗ КАССЫ
     * ---------------------------------------------
     *
     * debt:
     * ничего не списываем.
     *
     * cash:
     * списываем из текущего филиала.
     */

    if (paymentMethod === "cash" && purchaseAmount > 0) {
      /**
       * Повторно читаем файл,
       * чтобы получить актуальное состояние.
       */

      const latestCash = readCash();

      if (!latestCash[branchKey]) {
        latestCash[branchKey] = createEmptyCashBranch();
      }

      const currentBalance = Number(latestCash[branchKey].balance || 0);

      /**
       * Защита от ситуации,
       * когда касса изменилась между
       * предварительной проверкой и Supply.
       *
       * Supply уже создан, поэтому здесь
       * просто не допускаем отрицательного
       * баланса.
       */

      if (currentBalance < purchaseAmount) {
        console.error(
          "Критическая ситуация: Supply создан, но кассы недостаточно",
        );

        return res.status(500).json({
          success: false,

          message:
            "Поступление в МойСклад создано, но списание из кассы не выполнено: баланс изменился до завершения операции.",
        });
      }

      const balanceBefore = currentBalance;

      const balanceAfter = balanceBefore - purchaseAmount;

      latestCash[branchKey].balance = balanceAfter;

      if (!Array.isArray(latestCash[branchKey].transactions)) {
        latestCash[branchKey].transactions = [];
      }

      latestCash[branchKey].transactions.push({
        id: `CASH-BUY-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,

        type: "buyFromPostavshik",

        amount: -purchaseAmount,

        balanceBefore,

        balanceAfter,

        branch: branchKey,

        supplierId: supplier.id,

        supplierName: supplier.name || supplier.id,

        receiptId: moyskladSupply.id,

        comment: "Оплата поставщику за поступление",

        createdAt: new Date().toISOString(),
      });

      writeCash(latestCash);
    }

    /**
     * ---------------------------------------------
     * ЛОКАЛЬНАЯ ЗАПИСЬ
     * ---------------------------------------------
     */

    const transfers = readTransfers();

    const localReceipt = {
      id: `SUP-${Date.now()}`,

      type: "supplier_receipt",

      status: "received",

      branch: branchKey,

      moyskladId: moyskladSupply.id,

      paymentStatus: paymentMethod,

      totalAmount: purchaseAmount,

      moyskladHref: moyskladSupply.meta?.href || null,

      toWarehouse: {
        id: store.id,

        name: store.name || store.id,
      },

      supplier: {
        id: supplier.id,

        name: supplier.name || supplier.id,
      },

      items: items.map((item) => ({
        assortmentId: item.assortmentId,

        name: item.name,
        assortmentMeta: item.assortmentMeta || null,
        quantity: Number(item.quantity),

        price: Number(item.price || 0),
      })),

      createdAt: new Date().toISOString(),

      receivedAt: new Date().toISOString(),
    };

    if (!Array.isArray(transfers[branchKey])) {
      transfers[branchKey] = [];
    }

    transfers[branchKey].push(localReceipt);

    writeTransfers(transfers);

    res.status(201).json({
      success: true,

      transfer: localReceipt,

      moysklad: {
        id: moyskladSupply.id,

        href: moyskladSupply.meta?.href || null,
      },
    });
  } catch (error) {
    console.error("POST /api/transfers/receipt:", error);

    res.status(500).json({
      message: error.message || "Не удалось создать поступление",
    });
  }
});

/**
 * ----------------------------------------------------
 * POST /api/transfers/:id/confirm
 * ----------------------------------------------------
 *
 * Подтверждение входящего перемещения.
 *
 * Ищем запись во всех филиалах, потому что
 * отправитель сохраняет её в своём филиале.
 */

router.post("/:id/confirm", async (req, res) => {
  try {
    const { id } = req.params;

    const { receivedItems } = req.body || {};

    const currentBranch = getCurrentBranch();

    const currentStoreId = currentBranch.storeId;

    if (!currentStoreId) {
      return res.status(500).json({
        message: "У текущего филиала не указан storeId",
      });
    }

    if (!Array.isArray(receivedItems)) {
      return res.status(400).json({
        message: "Не переданы фактически принятые количества",
      });
    }

    const transfersStorage = readTransfers();

    let foundBranchKey = null;
    let foundIndex = -1;

    /**
     * ------------------------------------------------
     * Ищем перемещение во всех филиалах
     * ------------------------------------------------
     */

    for (const branchKey of BRANCH_KEYS) {
      const rows = transfersStorage[branchKey] || [];

      const index = rows.findIndex((item) => item.id === id);

      if (index !== -1) {
        foundBranchKey = branchKey;
        foundIndex = index;
        break;
      }
    }

    if (foundBranchKey === null || foundIndex === -1) {
      return res.status(404).json({
        message: "Перемещение не найдено",
      });
    }

    const transfer = transfersStorage[foundBranchKey][foundIndex];

    /**
     * ------------------------------------------------
     * Проверки
     * ------------------------------------------------
     */

    if (transfer.type !== "transfer") {
      return res.status(400).json({
        message: "Эту запись нельзя подтвердить как перемещение",
      });
    }

    if (transfer.toWarehouse?.id !== currentStoreId) {
      return res.status(403).json({
        message: "Это перемещение предназначено для другого филиала",
      });
    }

    if (transfer.status === "received") {
      return res.status(400).json({
        message: "Перемещение уже принято",
      });
    }

    if (!Array.isArray(transfer.items) || transfer.items.length === 0) {
      return res.status(400).json({
        message: "В перемещении нет товаров",
      });
    }

    /**
     * ------------------------------------------------
     * receivedItems -> Map
     * ------------------------------------------------
     */

    const receivedMap = new Map();

    for (const row of receivedItems) {
      const assortmentId = String(row?.assortmentId || "");

      if (!assortmentId) {
        return res.status(400).json({
          message: "У одного из принятых товаров отсутствует assortmentId",
        });
      }

      if (receivedMap.has(assortmentId)) {
        return res.status(400).json({
          message: `Товар ${assortmentId} передан несколько раз`,
        });
      }

      receivedMap.set(assortmentId, row);
    }

    /**
     * ------------------------------------------------
     * Рассчитываем фактическую приемку
     * ------------------------------------------------
     */

    const updatedItems = transfer.items.map((item) => {
      const assortmentId = String(item.assortmentId);

      const receivedRow = receivedMap.get(assortmentId);

      if (!receivedRow) {
        throw new Error(`Не указано принятое количество для "${item.name}"`);
      }

      const sentQuantity = Number(item.quantity);

      const receivedQuantity = Number(
        String(receivedRow.receivedQuantity ?? "").replace(",", "."),
      );

      if (!Number.isFinite(sentQuantity) || sentQuantity < 0) {
        throw new Error(
          `Некорректное отправленное количество для "${item.name}"`,
        );
      }

      if (!Number.isFinite(receivedQuantity) || receivedQuantity < 0) {
        throw new Error(`Некорректное принятое количество для "${item.name}"`);
      }

      // if (receivedQuantity > sentQuantity) {
      //   throw new Error(
      //     `Для "${item.name}" нельзя принять ${receivedQuantity} шт. — отправлено только ${sentQuantity} шт.`,
      //   );
      // }

      const shortageQuantity = Math.max(sentQuantity - receivedQuantity, 0);

      const excessQuantity = Math.max(receivedQuantity - sentQuantity, 0);

      return {
        ...item,

        receivedQuantity,

        shortageQuantity,

        excessQuantity,
      };
    });

    /**
     * ------------------------------------------------
     * Итоги
     * ------------------------------------------------
     */

    const totalSentQuantity = updatedItems.reduce(
      (sum, item) => sum + Number(item.quantity || 0),
      0,
    );

    const totalReceivedQuantity = updatedItems.reduce(
      (sum, item) => sum + Number(item.receivedQuantity || 0),
      0,
    );

    const totalShortageQuantity = updatedItems.reduce(
      (sum, item) => sum + Number(item.shortageQuantity || 0),
      0,
    );

    const totalExcessQuantity = updatedItems.reduce(
      (sum, item) => sum + Number(item.excessQuantity || 0),
      0,
    );

    /**
     * ------------------------------------------------
     * ЕСЛИ ЕСТЬ НЕДОСТАЧА
     *
     * Создаём Списание в МойСклад
     * на складе-получателе.
     * ------------------------------------------------
     */

    let shortageLoss = null;

    if (totalShortageQuantity > 0) {
      /**
       * Получаем организацию.
       */

      const organizations = await moyskladRequest(
        "/entity/organization?limit=100",
      );

      if (!organizations.rows || organizations.rows.length === 0) {
        throw new Error(
          "В МойСклад не найдена организация для списания недостачи",
        );
      }

      const organization = organizations.rows[0];

      /**
       * Для старых локальных перемещений
       * assortmentMeta может отсутствовать.
       *
       * В таком случае восстанавливаем meta
       * по ID товара.
       */

      const itemsForLoss = await Promise.all(
        updatedItems.map(async (item) => {
          if (Number(item.shortageQuantity || 0) <= 0) {
            return item;
          }

          if (item.assortmentMeta) {
            return item;
          }

          /**
           * Если meta отсутствует,
           * получаем товар из МойСклад.
           */

          const assortment = await moyskladRequest(
            `/entity/product/${item.assortmentId}`,
          );

          if (!assortment?.meta) {
            throw new Error(
              `Не удалось получить товар "${item.name}" из МойСклад`,
            );
          }

          return {
            ...item,
            assortmentMeta: assortment.meta,
          };
        }),
      );

      shortageLoss = await createShortageLoss({
        storeId: currentStoreId,

        organizationId: organization.id,

        items: itemsForLoss,

        transferId: transfer.moyskladId || transfer.id,
      });
    }

    /**
     * ------------------------------------------------
     * ЕСЛИ ЕСТЬ ИЗЛИШЕК
     *
     * Создаём Оприходование в МойСклад
     * на складе-получателе.
     * ------------------------------------------------
     */

    let excessSupply = null;

    if (totalExcessQuantity > 0) {
      /**
       * Получаем организацию.
       *
       * Если выше уже получали организацию
       * для недостачи, здесь получаем её отдельно
       * только если есть излишек.
       */

      const organizations = await moyskladRequest(
        "/entity/organization?limit=100",
      );

      if (!organizations.rows || organizations.rows.length === 0) {
        throw new Error(
          "В МойСклад не найдена организация для оприходования излишка",
        );
      }

      const organization = organizations.rows[0];

      /**
       * Для старых локальных перемещений
       * восстанавливаем assortmentMeta.
       */

      const itemsForExcess = await Promise.all(
        updatedItems.map(async (item) => {
          if (Number(item.excessQuantity || 0) <= 0) {
            return item;
          }

          if (item.assortmentMeta) {
            return item;
          }

          const assortment = await moyskladRequest(
            `/entity/product/${item.assortmentId}`,
          );

          if (!assortment?.meta) {
            throw new Error(
              `Не удалось получить товар "${item.name}" из МойСклад`,
            );
          }

          return {
            ...item,

            assortmentMeta: assortment.meta,
          };
        }),
      );

      excessSupply = await createExcessSupply({
        storeId: currentStoreId,

        organizationId: organization.id,

        items: itemsForExcess,

        transferId: transfer.moyskladId || transfer.id,
      });
    }

    /**
     * ------------------------------------------------
     * Сохраняем результат приемки
     * ------------------------------------------------
     */

    transfer.items = updatedItems;

    transfer.totalSentQuantity = totalSentQuantity;

    transfer.totalReceivedQuantity = totalReceivedQuantity;

    transfer.totalShortageQuantity = totalShortageQuantity;

    transfer.status = "received";

    transfer.receivedAt = new Date().toISOString();

    transfer.receivedByBranch = currentBranch.id;

    transfer.receivedStoreId = currentStoreId;

    /**
     * Информация о списании недостачи
     */

    transfer.shortageLoss = shortageLoss;

    transfer.shortageLossId = shortageLoss?.id || null;

    transfer.shortageLossHref = shortageLoss?.href || null;
    transfer.excessSupply = excessSupply;

    transfer.excessSupplyId = excessSupply?.id || null;

    transfer.excessSupplyHref = excessSupply?.href || null;
    /**
     * Сохраняем запись.
     */

    transfersStorage[foundBranchKey][foundIndex] = transfer;

    writeTransfers(transfersStorage);

    return res.json({
      success: true,

      transfer,

      shortage: {
        quantity: totalShortageQuantity,

        loss: shortageLoss,
      },

      excess: {
        quantity: totalExcessQuantity,

        supply: excessSupply,
      },
    });
  } catch (error) {
    console.error("POST /api/transfers/:id/confirm:", error);

    return res.status(500).json({
      message: error.message || "Не удалось подтвердить перемещение",
    });
  }
});

/**
 * ----------------------------------------------------
 * GET /api/transfers/config
 * ----------------------------------------------------
 */

router.get("/config", async (req, res) => {
  try {
    const [organizations, stores] = await Promise.all([
      moyskladRequest("/entity/organization?limit=100"),

      moyskladRequest("/entity/store?limit=100"),
    ]);

    let agent = null;

    if (AGENT_ID) {
      try {
        agent = await moyskladRequest(`/entity/counterparty/${AGENT_ID}`);
      } catch {
        agent = null;
      }
    }

    let branch = null;

    try {
      const currentBranch = getCurrentBranch();

      branch = {
        key: getBranchKey(currentBranch),

        storeId: currentBranch.storeId || null,

        retailStoreId: currentBranch.retailStoreId || null,

        name: currentBranch.name || null,
      };
    } catch {
      branch = null;
    }

    res.json({
      success: true,

      auth: {
        loginConfigured: Boolean(LOGIN),

        passwordConfigured: Boolean(PASSWORD),
      },

      branch,

      retailStoreId: RETAIL_STORE_ID || null,

      agent: agent
        ? {
            id: agent.id,
            name: agent.name,
          }
        : null,

      organizations: (organizations.rows || []).map((organization) => ({
        id: organization.id,

        name: organization.name,
      })),

      stores: (stores.rows || []).map((store) => ({
        id: store.id,

        name: store.name,

        code: store.code || null,

        pathName: store.pathName || "",
      })),
    });
  } catch (error) {
    console.error("GET /api/transfers/config:", error);

    res.status(500).json({
      success: false,

      message: error.message || "Не удалось получить конфигурацию МойСклад",
    });
  }
});

module.exports = router;
