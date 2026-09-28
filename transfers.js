const express = require("express");
const fs = require("fs");
const path = require("path");

const router = express.Router();

const MOYSKLAD_API = "https://api.moysklad.ru/api/remap/1.2";

const LOGIN = process.env.MOYSKLAD_LOGIN;
const PASSWORD = process.env.MOYSKLAD_PASSWORD;

const AGENT_ID = process.env.MOYSKLAD_AGENT;

// Это ID именно розничной точки / кассы.
// Для перемещений он НЕ используется.
const RETAIL_STORE_ID = process.env.MOYSKLAD_RETAIL_STORE_ID;

const DATA_DIR = path.join(__dirname, "..", "data");
const TRANSFERS_FILE = path.join(DATA_DIR, "transfers.json");
const CASH_FILE = path.join(DATA_DIR, "cash.json");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

if (!fs.existsSync(TRANSFERS_FILE)) {
  fs.writeFileSync(TRANSFERS_FILE, JSON.stringify([], null, 2), "utf8");
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

/**
 * ----------------------------------------------------
 * Local JSON
 * ----------------------------------------------------
 */

function readTransfers() {
  try {
    const content = fs.readFileSync(TRANSFERS_FILE, "utf8");

    return JSON.parse(content);
  } catch (error) {
    console.error("Ошибка чтения transfers.json:", error);

    return [];
  }
}

function writeTransfers(data) {
  fs.writeFileSync(TRANSFERS_FILE, JSON.stringify(data, null, 2), "utf8");
}

function readCash() {
  try {
    if (!fs.existsSync(CASH_FILE)) {
      return {
        balance: 0,
        transactions: [],
      };
    }

    const content = fs.readFileSync(CASH_FILE, "utf8");

    return JSON.parse(content);
  } catch (error) {
    console.error("Ошибка чтения cash.json:", error);

    return {
      balance: 0,
      transactions: [],
    };
  }
}

function writeCash(data) {
  fs.writeFileSync(CASH_FILE, JSON.stringify(data, null, 2), "utf8");
}

/**
 * ----------------------------------------------------
 * GET /api/transfers
 *
 * Все локальные перемещения/поступления
 * ----------------------------------------------------
 */

router.get("/", (req, res) => {
  try {
    const transfers = readTransfers();

    res.json({
      rows: transfers,
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      message: error.message || "Не удалось загрузить перемещения",
    });
  }
});

/**
 * ----------------------------------------------------
 * GET /api/transfers/warehouses
 *
 * Получаем склады/магазины из МойСклад
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
 *
 * Получаем контрагентов.
 *
 * На фронте можно выбрать нужного поставщика.
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
 *
 * Получаем входящие перемещения.
 *
 * Важно:
 * Это локальные записи, которые были созданы
 * нашей системой.
 * ----------------------------------------------------
 */

router.get("/incoming", (req, res) => {
  try {
    const storeId = req.query.storeId;

    if (!storeId) {
      return res.status(400).json({
        message: "Не передан storeId",
      });
    }

    const transfers = readTransfers();

    const incoming = transfers
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
    console.error(error);

    res.status(500).json({
      message: error.message || "Не удалось загрузить входящие перемещения",
    });
  }
});

/**
 * ----------------------------------------------------
 * POST /api/transfers/outgoing
 *
 * Филиал A -> Филиал B
 *
 * Создаём:
 *
 * МойСклад:
 * entity/move
 *
 * Локально:
 * transfers.json
 * ----------------------------------------------------
 */

router.post("/outgoing", async (req, res) => {
  try {
    const { fromWarehouseId, toWarehouseId, items } = req.body;

    if (!fromWarehouseId) {
      return res.status(400).json({
        message: "Не указан склад отправителя",
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

    /**
     * Получаем организацию.
     *
     * Если в аккаунте несколько организаций,
     * пока берём первую.
     */
    const organizations = await moyskladRequest(
      "/entity/organization?limit=100",
    );

    if (!organizations.rows || organizations.rows.length === 0) {
      throw new Error("В МойСклад не найдена организация");
    }

    const organization = organizations.rows[0];

    /**
     * Формируем позиции перемещения.
     */

    const positions = items.map((item) => {
      if (!item.assortmentId) {
        throw new Error(`У товара "${item.name}" отсутствует assortmentId`);
      }

      const quantity = Number(item.quantity);

      if (!Number.isFinite(quantity) || quantity <= 0) {
        throw new Error(`Некорректное количество товара "${item.name}"`);
      }

      return {
        quantity,
        assortment: {
          meta: item.assortmentMeta,
        },
      };
    });

    /**
     * Создаём перемещение в МойСклад.
     */

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

    /**
     * Получаем названия складов,
     * чтобы локальная запись была удобной.
     */

    const stores = await moyskladRequest("/entity/store?limit=100");

    const sourceStore = stores.rows?.find(
      (store) => store.id === fromWarehouseId,
    );

    const targetStore = stores.rows?.find(
      (store) => store.id === toWarehouseId,
    );

    /**
     * Локальная запись.
     */

    const transfers = readTransfers();

    const localTransfer = {
      id: `TR-${Date.now()}`,

      type: "transfer",

      status: "sent",
      paymentStatus: moyskladMove.paymentMethod,

      moyskladId: moyskladMove.id,

      moyskladHref: moyskladMove.meta?.href || null,

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
        quantity: Number(item.quantity),
        price: Number(item.price || 0),
      })),

      createdAt: new Date().toISOString(),

      receivedAt: null,
    };

    transfers.push(localTransfer);

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
 * POST /api/transfers/receipt
 *
 * Поступление от поставщика.
 *
 * Создаём:
 *
 * МойСклад:
 * entity/supply
 *
 * Локально:
 * transfers.json
 * ----------------------------------------------------
 */

/**
 * ----------------------------------------------------
 * Раскрытие комплекта
 * ----------------------------------------------------
 *
 * Supply не принимает bundle напрямую.
 * Поэтому получаем состав комплекта и
 * превращаем его в обычные позиции.
 */
/**
 * ----------------------------------------------------
 * Раскрытие комплекта для Supply
 * ----------------------------------------------------
 *
 * ВАЖНО:
 * МойСклад НЕ разрешает:
 *
 * supply.positions.rows[].assortment.type === "bundle"
 *
 * Поэтому комплект полностью раскрываем
 * в его компоненты.
 */
async function expandBundle(item) {
  if (!item.assortmentId) {
    throw new Error(
      `У товара "${item.name}" отсутствует assortmentId`,
    );
  }

  const quantity = Number(item.quantity);

  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new Error(
      `Некорректное количество товара "${item.name}"`,
    );
  }

  /**
   * Тип ассортимента уже приходит с фронта.
   *
   * product.meta:
   * {
   *   href: ".../entity/product/...",
   *   type: "product"
   * }
   *
   * bundle.meta:
   * {
   *   href: ".../entity/bundle/...",
   *   type: "bundle"
   * }
   */

  const assortmentMeta = item.assortmentMeta;

  if (!assortmentMeta) {
    throw new Error(
      `У товара "${item.name}" отсутствует assortmentMeta`,
    );
  }

  const assortmentType =
    assortmentMeta.type ||
    assortmentMeta.meta?.type;

  console.log(
    `Товар "${item.name}" -> тип: ${assortmentType}`,
  );

  /**
   * --------------------------------------------------
   * Обычный товар / модификация
   * --------------------------------------------------
   */

  if (assortmentType !== "bundle") {
    return [
      {
        quantity,

        price: Math.round(
          Number(item.price || 0) * 100,
        ),

        assortment: {
          meta: assortmentMeta,
        },
      },
    ];
  }

  /**
   * --------------------------------------------------
   * Это комплект
   * --------------------------------------------------
   */

  const bundleId =
    assortmentMeta.href
      ?.split("/")
      .filter(Boolean)
      .pop();

  if (!bundleId) {
    throw new Error(
      `Не удалось определить ID комплекта "${item.name}"`,
    );
  }

  console.log(
    `Получаем комплект ${bundleId} из МойСклад`,
  );

  /**
   * Получаем комплект правильным endpoint:
   *
   * /entity/bundle/{id}
   */

const bundle = await moyskladRequest(
  `/entity/bundle/${bundleId}`,
);

if (!bundle?.id) {
  throw new Error(
    `Комплект "${item.name}" не найден в МойСклад`,
  );
}

/**
 * Компоненты комплекта получаем
 * отдельным endpoint.
 */
const componentsData = await moyskladRequest(
  `/entity/bundle/${bundleId}/components?limit=100`,
);

const components =
  componentsData?.rows || [];

console.log(
  `КОМПОНЕНТЫ КОМПЛЕКТА "${item.name}":`,
  JSON.stringify(components, null, 2),
);

if (components.length === 0) {
  throw new Error(
    `Комплект "${item.name}" не содержит компонентов`,
  );
}

  if (components.length === 0) {
    throw new Error(
      `Комплект "${item.name}" не содержит компонентов`,
    );
  }

  /**
   * Цена всего комплекта.
   */

  const bundlePrice =
    Number(item.price || 0);

  /**
   * Общее количество частей.
   */

  const totalParts =
    components.reduce(
      (sum, component) =>
        sum + Number(component.quantity || 0),
      0,
    );

  const result = [];

  /**
   * --------------------------------------------------
   * Раскрываем комплект
   * --------------------------------------------------
   */

  for (const component of components) {
    const componentQuantity =
      Number(component.quantity || 0);

    if (
      !Number.isFinite(componentQuantity) ||
      componentQuantity <= 0
    ) {
      continue;
    }

    const componentMeta =
      component.assortment?.meta;

    if (!componentMeta) {
      throw new Error(
        `У компонента комплекта "${item.name}" отсутствует assortment.meta`,
      );
    }

    /**
     * Вложенный комплект пока запрещаем.
     */

    if (componentMeta.type === "bundle") {
      throw new Error(
        `Комплект "${item.name}" содержит вложенный комплект. Такой комплект нужно обработать отдельно.`,
      );
    }

    /**
     * Количество компонента:
     *
     * компонент × количество комплектов
     */

    const finalQuantity =
      componentQuantity * quantity;

    /**
     * Распределяем стоимость комплекта
     * между компонентами.
     */

    const componentPrice =
      totalParts > 0
        ? bundlePrice *
          (componentQuantity / totalParts)
        : 0;

    result.push({
      quantity: finalQuantity,

      price: Math.round(
        componentPrice * 100,
      ),

      assortment: {
        meta: componentMeta,
      },
    });
  }

  if (result.length === 0) {
    throw new Error(
      `Комплект "${item.name}" не удалось раскрыть`,
    );
  }

  console.log(
    `Комплект "${item.name}" раскрыт:`,
    JSON.stringify(result, null, 2),
  );

  return result;
}

router.post("/receipt", async (req, res) => {


  try {
    const { storeId, supplierId, items, totalAmount, paymentMethod } = req.body;

    if (!storeId) {
      return res.status(400).json({
        message: "Не указан склад поступления",
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
     * Проверяем товары и получаем
     * настоящие meta из МойСклад
     * ---------------------------------------------
     */

const positions = [];

for (const item of items) {
  const expandedPositions =
    await expandBundle(item);

  positions.push(...expandedPositions);
}

if (positions.length === 0) {
  throw new Error(
    "После обработки товаров не осталось позиций",
  );
}

    /**
     * ---------------------------------------------
     * Supply
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
     * Создаём поступление
     * ---------------------------------------------
     */

    const moyskladSupply = await moyskladRequest("/entity/supply", {
      method: "POST",

      body: JSON.stringify(supplyData),
    });

    /**
     * ---------------------------------------------
     * Списание денег из кассы
     * ---------------------------------------------
     */

    const purchaseAmount = Number(totalAmount || 0);

    if (!Number.isFinite(purchaseAmount) || purchaseAmount < 0) {
      throw new Error("Некорректная сумма поступления");
    }

    if (paymentMethod === "cash" && purchaseAmount > 0) {
      const cash = readCash();

      const currentBalance = Number(cash.balance || 0);

      if (currentBalance < purchaseAmount) {
        throw new Error(
          `Недостаточно денег в кассе. Баланс: ${currentBalance} сом, требуется: ${purchaseAmount} сом`,
        );
      }

      const balanceBefore = currentBalance;
      const balanceAfter = balanceBefore - purchaseAmount;

      cash.balance = balanceAfter;

      if (!Array.isArray(cash.transactions)) {
        cash.transactions = [];
      }

      cash.transactions.push({
        id: `CASH-BUY-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,

        type: "buyFromPostavshik",

        amount: -purchaseAmount,

        balanceBefore,

        balanceAfter,

        supplierId: supplier.id,

        supplierName: supplier.name || supplier.id,

        receiptId: moyskladSupply.id,

        comment: "Оплата поставщику за поступление",

        createdAt: new Date().toISOString(),
      });

      writeCash(cash);
    }

    /**
     * ---------------------------------------------
     * Локальная запись
     * ---------------------------------------------
     */

    const transfers = readTransfers();

    const localReceipt = {
      id: `SUP-${Date.now()}`,

      type: "supplier_receipt",

      status: "received",

      moyskladId: moyskladSupply.id,
      paymentStatus: paymentMethod,
      totalAmount: Number(totalAmount || 0),
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

        quantity: Number(item.quantity),

        price: Number(item.price || 0),
      })),

      createdAt: new Date().toISOString(),

      receivedAt: new Date().toISOString(),
    };

    transfers.push(localReceipt);

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
 *
 * Подтверждаем локальный приём
 * перемещения между филиалами.
 *
 * ВАЖНО:
 * Второй supply здесь НЕ создаём.
 * ----------------------------------------------------
 */

router.post("/:id/confirm", (req, res) => {
  try {
    const { id } = req.params;

    const transfers = readTransfers();

    const index = transfers.findIndex((item) => item.id === id);

    if (index === -1) {
      return res.status(404).json({
        message: "Перемещение не найдено",
      });
    }

    const transfer = transfers[index];

    if (transfer.type !== "transfer") {
      return res.status(400).json({
        message: "Эту запись нельзя подтвердить как перемещение",
      });
    }

    if (transfer.status === "received") {
      return res.status(400).json({
        message: "Перемещение уже принято",
      });
    }

    transfer.status = "received";

    transfer.receivedAt = new Date().toISOString();

    transfers[index] = transfer;

    writeTransfers(transfers);

    res.json({
      success: true,
      transfer,
    });
  } catch (error) {
    console.error("POST /api/transfers/:id/confirm:", error);

    res.status(500).json({
      message: error.message || "Не удалось подтвердить перемещение",
    });
  }
});

/**
 * ----------------------------------------------------
 * GET /api/transfers/config
 *
 * Небольшой диагностический endpoint.
 *
 * Позволит проверить:
 * - авторизацию
 * - организацию
 * - склады
 * - текущего контрагента
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

    res.json({
      success: true,

      auth: {
        loginConfigured: Boolean(LOGIN),
        passwordConfigured: Boolean(PASSWORD),
      },

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
