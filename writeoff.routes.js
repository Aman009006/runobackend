const express = require("express");
const fs = require("fs/promises");
const path = require("path");

const router = express.Router();

const { getCurrentBranch } = require("./branchContext");

const MOYSKLAD_LOGIN = process.env.MOYSKLAD_LOGIN;
const MOYSKLAD_PASSWORD = process.env.MOYSKLAD_PASSWORD;

const MOYSKLAD_API = "https://api.moysklad.ru/api/remap/1.2";

/*
|--------------------------------------------------------------------------
| BRANCHES
|--------------------------------------------------------------------------
*/

const BRANCHES = ["bishkek", "dordoy", "osh"];

/*
|--------------------------------------------------------------------------
| FILES
|--------------------------------------------------------------------------
*/

const DATA_DIR = path.join(__dirname, "..", "data");

const WHITEOFF_FILE = path.join(DATA_DIR, "whiteoff.json");

let accessToken = null;

/*
|--------------------------------------------------------------------------
| BRANCH
|--------------------------------------------------------------------------
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

/*
|--------------------------------------------------------------------------
| MOYSKLAD AUTH
|--------------------------------------------------------------------------
*/

async function getAccessToken() {
  if (accessToken) {
    return accessToken;
  }

  if (!MOYSKLAD_LOGIN || !MOYSKLAD_PASSWORD) {
    throw new Error("Не заданы MOYSKLAD_LOGIN и MOYSKLAD_PASSWORD");
  }

  const credentials = Buffer.from(
    `${MOYSKLAD_LOGIN}:${MOYSKLAD_PASSWORD}`,
  ).toString("base64");

  const response = await fetch(`${MOYSKLAD_API}/security/token`, {
    method: "POST",

    headers: {
      Authorization: `Basic ${credentials}`,

      Accept: "application/json;charset=utf-8",
    },
  });

  if (!response.ok) {
    const text = await response.text();

    throw new Error(`Ошибка авторизации MoySklad: ${response.status} ${text}`);
  }

  const data = await response.json();

  if (!data.access_token) {
    throw new Error("MoySklad не вернул access_token");
  }

  accessToken = data.access_token;

  return accessToken;
}

/*
|--------------------------------------------------------------------------
| MOYSKLAD REQUEST
|--------------------------------------------------------------------------
*/

async function moySkladRequest(endpoint, options = {}, retry = true) {
  const token = await getAccessToken();

  const response = await fetch(`${MOYSKLAD_API}${endpoint}`, {
    ...options,

    headers: {
      Accept: "application/json;charset=utf-8",

      "Content-Type": "application/json",

      Authorization: `Bearer ${token}`,

      ...(options.headers || {}),
    },
  });

  /*
   * Если токен истёк —
   * получаем новый и повторяем запрос.
   */

  if (response.status === 401 && retry) {
    accessToken = null;

    return moySkladRequest(endpoint, options, false);
  }

  const text = await response.text();

  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    const errorMessage =
      data?.errors?.[0]?.error ||
      data?.message ||
      data?.error ||
      text ||
      `HTTP ${response.status}`;

    throw new Error(`MoySklad API ${response.status}: ${errorMessage}`);
  }

  return data;
}

/*
|--------------------------------------------------------------------------
| DATE HELPERS
|--------------------------------------------------------------------------
*/

function getLocalDateTime() {
  const formatter = new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Asia/Bishkek",

    year: "numeric",
    month: "2-digit",
    day: "2-digit",

    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",

    hour12: false,
  });

  const parts = formatter.formatToParts(new Date());

  const values = {};

  for (const part of parts) {
    values[part.type] = part.value;
  }

  return (
    `${values.year}-${values.month}-${values.day} ` +
    `${values.hour}:${values.minute}:${values.second}`
  );
}

function getLocalDate() {
  const formatter = new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Asia/Bishkek",

    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  const parts = formatter.formatToParts(new Date());

  const values = {};

  for (const part of parts) {
    values[part.type] = part.value;
  }

  return `${values.year}-${values.month}-${values.day}`;
}

/*
|--------------------------------------------------------------------------
| WHITE-OFF STORAGE
|--------------------------------------------------------------------------
*/

function createEmptyWriteoffData() {
  return {
    bishkek: {},
    dordoy: {},
    osh: {},
  };
}

function isBranchWriteoffFormat(data) {
  return (
    data &&
    typeof data === "object" &&
    !Array.isArray(data) &&
    (Object.prototype.hasOwnProperty.call(data, "bishkek") ||
      Object.prototype.hasOwnProperty.call(data, "dordoy") ||
      Object.prototype.hasOwnProperty.call(data, "osh"))
  );
}

async function ensureWriteoffStorage() {
  await fs.mkdir(DATA_DIR, {
    recursive: true,
  });

  try {
    await fs.access(WHITEOFF_FILE);
  } catch {
    await fs.writeFile(
      WHITEOFF_FILE,
      JSON.stringify(createEmptyWriteoffData(), null, 2),
      "utf8",
    );
  }
}

async function readWriteoffData() {
  await ensureWriteoffStorage();

  const content = await fs.readFile(WHITEOFF_FILE, "utf8");

  /*
   * Если файл пустой —
   * создаём правильную структуру.
   */

  if (!content.trim()) {
    const emptyData = createEmptyWriteoffData();

    await fs.writeFile(
      WHITEOFF_FILE,
      JSON.stringify(emptyData, null, 2),
      "utf8",
    );

    return emptyData;
  }

  try {
    const data = JSON.parse(content);

    /*
     * Новый формат:
     *
     * {
     *   bishkek: {},
     *   dordoy: {},
     *   osh: {}
     * }
     */

    if (isBranchWriteoffFormat(data)) {
      let changed = false;

      for (const branch of BRANCHES) {
        if (
          !data[branch] ||
          typeof data[branch] !== "object" ||
          Array.isArray(data[branch])
        ) {
          data[branch] = {};
          changed = true;
        }
      }

      if (changed) {
        await fs.writeFile(
          WHITEOFF_FILE,
          JSON.stringify(data, null, 2),
          "utf8",
        );
      }

      return data;
    }

    /*
     * Старый формат:
     *
     * {
     *   "2026-10-08": [...]
     * }
     *
     * Переносим старые списания
     * в текущий филиал.
     */

    if (data && typeof data === "object" && !Array.isArray(data)) {
      const branchKey = getBranchKey();

      const migrated = createEmptyWriteoffData();

      migrated[branchKey] = data;

      await fs.writeFile(
        WHITEOFF_FILE,
        JSON.stringify(migrated, null, 2),
        "utf8",
      );

      return migrated;
    }

    /*
     * Если формат неизвестный —
     * создаём чистое хранилище.
     */

    const emptyData = createEmptyWriteoffData();

    await fs.writeFile(
      WHITEOFF_FILE,
      JSON.stringify(emptyData, null, 2),
      "utf8",
    );

    return emptyData;
  } catch (error) {
    console.error("Ошибка JSON whiteoff.json:", error);

    throw new Error("Не удалось прочитать whiteoff.json");
  }
}

async function saveWriteoffToJson(writeoff) {
  await ensureWriteoffStorage();

  const branchKey = getBranchKey();

  let allWriteoffs = await readWriteoffData();

  /*
   * Дополнительная защита.
   */

  if (!isBranchWriteoffFormat(allWriteoffs)) {
    allWriteoffs = createEmptyWriteoffData();
  }

  /*
   * Гарантируем наличие
   * всех филиалов.
   */

  for (const branch of BRANCHES) {
    if (
      !allWriteoffs[branch] ||
      typeof allWriteoffs[branch] !== "object" ||
      Array.isArray(allWriteoffs[branch])
    ) {
      allWriteoffs[branch] = {};
    }
  }

  const date = writeoff.date || getLocalDate();

  if (!Array.isArray(allWriteoffs[branchKey][date])) {
    allWriteoffs[branchKey][date] = [];
  }

  allWriteoffs[branchKey][date].push(writeoff);

  await fs.writeFile(
    WHITEOFF_FILE,
    JSON.stringify(allWriteoffs, null, 2),
    "utf8",
  );

  return writeoff;
}

/*
|--------------------------------------------------------------------------
| TYPE
|--------------------------------------------------------------------------
*/

function normalizeType(type) {
  const value = String(type || "")
    .toLowerCase()
    .trim();

  if (value === "variant") {
    return "variant";
  }

  if (value === "bundle") {
    return "bundle";
  }

  return "product";
}

/*
|--------------------------------------------------------------------------
| ASSORTMENT META
|--------------------------------------------------------------------------
*/

function buildAssortmentMeta(item) {
  const type = normalizeType(item.type);

  const id = String(item.id || "").trim();

  if (!id) {
    throw new Error(`Не указан id товара: ${item.name || "Без названия"}`);
  }

  if (
    item.assortmentMeta &&
    item.assortmentMeta.href &&
    item.assortmentMeta.type
  ) {
    return {
      ...item.assortmentMeta,
    };
  }

  if (item.meta && item.meta.href && item.meta.type) {
    return {
      ...item.meta,
    };
  }

  return {
    href: `${MOYSKLAD_API}/entity/${type}/${id}`,

    type,

    mediaType: "application/json",
  };
}

/*
|--------------------------------------------------------------------------
| POST /writeoffs
|--------------------------------------------------------------------------
|
| ВАЖНО:
|
| storeId НЕ принимается от frontend.
|
| Текущий склад определяется
| исключительно через getCurrentBranch().
|
*/

router.post("/writeoffs", async (req, res) => {
  try {
    /*
     * Получаем текущий филиал.
     */

    const branch = getCurrentBranch();

    if (!branch) {
      return res.status(500).json({
        success: false,

        message: "Не удалось определить текущий филиал.",
      });
    }

    /*
     * Ключ текущего филиала.
     */

    const branchKey = getBranchKey();

    /*
     * Склад текущего филиала.
     */

    const storeId = branch.storeId;

    if (!storeId) {
      return res.status(500).json({
        success: false,

        message: "У текущего филиала не указан storeId.",
      });
    }

    /*
     * Название текущего филиала.
     */

    const storeName = branch.storeName || branch.name || "";

    /*
     * ВАЖНО:
     *
     * storeId специально НЕ берём
     * из req.body.
     *
     * Frontend больше не может
     * выбрать чужой склад.
     */

    const { items, reason = "" } = req.body || {};

    /*
     * Проверяем товары.
     */

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,

        message: "Для списания необходимо передать товары.",
      });
    }

    /*
     * Нормализуем товары.
     */

    const normalizedItems = items
      .map((item) => {
        const quantity = Math.floor(Number(item.quantity));

        if (!item.id) {
          return null;
        }

        if (!Number.isFinite(quantity) || quantity <= 0) {
          return null;
        }

        return {
          id: String(item.id),

          name: item.name || "Без названия",

          quantity,

          type: normalizeType(item.type),

          assortmentMeta: item.assortmentMeta || item.meta || null,
        };
      })
      .filter(Boolean);

    if (normalizedItems.length === 0) {
      return res.status(400).json({
        success: false,

        message: "Нет корректных товаров для списания.",
      });
    }

    /*
     * Получаем организацию.
     */

    const organizationResponse = await moySkladRequest(
      "/entity/organization?limit=1",
    );

    const organization = organizationResponse?.rows?.[0];

    if (!organization?.meta) {
      throw new Error("Не удалось определить организацию MoySklad.");
    }

    /*
     * Магазин текущего филиала.
     */

    const storeMeta = {
      href: `${MOYSKLAD_API}/entity/store/${storeId}`,

      type: "store",

      mediaType: "application/json",
    };

    /*
     * Позиции списания.
     */

    const positions = normalizedItems.map((item) => {
      const position = {
        quantity: item.quantity,

        assortment: {
          meta: buildAssortmentMeta(item),
        },
      };

      /*
       * Причину добавляем,
       * только если она заполнена.
       */

      if (reason && String(reason).trim()) {
        position.reason = String(reason).trim();
      }

      return position;
    });

    /*
     * Данные для MoySklad.
     */

    const payload = {
      name: `Списание POS ${getLocalDateTime()}`,

      store: {
        meta: storeMeta,
      },

      organization: {
        meta: organization.meta,
      },

      positions,
    };

    /*
     * Логируем текущий филиал,
     * чтобы было легко проверить,
     * куда реально ушло списание.
     */

    console.log("================================");

    console.log("СОЗДАНИЕ СПИСАНИЯ");

    console.log("Филиал:", branchKey);

    console.log("Название филиала:", storeName || "Без названия");

    console.log("storeId:", storeId);

    console.log("Количество позиций:", normalizedItems.length);

    console.log(
      "Количество товаров:",
      normalizedItems.reduce((sum, item) => sum + item.quantity, 0),
    );

    console.log("================================");

    /*
     * Сначала создаём списание
     * в MoySklad.
     */

    const result = await moySkladRequest("/entity/loss", {
      method: "POST",

      body: JSON.stringify(payload),
    });

    /*
     * MoySklad успешно создал списание.
     *
     * Только после этого сохраняем
     * его локально.
     */

    const createdAt = getLocalDateTime();

    const date = createdAt.split(" ")[0];

    const writeoffId = result?.id || null;

    const writeoff = {
      id: writeoffId,

      moyskladId: writeoffId,

      moyskladHref: result?.meta?.href || null,

      name: result?.name || payload.name,

      date,

      createdAt,

      reason: String(reason || "").trim(),

      /*
       * Сохраняем именно тот
       * storeId, который определил backend.
       */

      storeId,

      storeName,

      /*
       * Дополнительно сохраняем
       * филиал.
       */

      branchId: branchKey,

      items: normalizedItems.map((item) => ({
        id: item.id,

        name: item.name,

        quantity: item.quantity,

        type: item.type,
      })),

      /*
       * Количество позиций.
       */

      itemsCount: normalizedItems.length,

      /*
       * Общее количество товаров.
       */

      totalQuantity: normalizedItems.reduce(
        (sum, item) => sum + item.quantity,
        0,
      ),
    };

    /*
     * Записываем в:
     *
     * data/whiteoff.json
     *
     * строго в текущий филиал.
     */

    await saveWriteoffToJson(writeoff);

    /*
     * Ответ клиенту.
     */

    return res.status(201).json({
      success: true,

      message:
        "Списание успешно создано в MoySklad и сохранено в whiteoff.json.",

      id: writeoffId,

      href: result?.meta?.href || null,

      date,

      createdAt,

      /*
       * Возвращаем frontend,
       * в какой филиал было записано.
       */

      branchId: branchKey,

      storeId,

      storeName,

      result,
    });
  } catch (error) {
    console.error("Ошибка создания списания:", error);

    return res.status(500).json({
      success: false,

      message: error?.message || "Ошибка создания списания.",
    });
  }
});

module.exports = router;
