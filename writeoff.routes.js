const express = require("express");
const fs = require("fs/promises");
const path = require("path");

const router = express.Router();

const MOYSKLAD_LOGIN = process.env.MOYSKLAD_LOGIN;
const MOYSKLAD_PASSWORD = process.env.MOYSKLAD_PASSWORD;

const MOYSKLAD_API =
  "https://api.moysklad.ru/api/remap/1.2";

const DEFAULT_STORE_ID =
  "40b43662-2117-11f1-0a80-1cb200302c3c";

/*
|--------------------------------------------------------------------------
| FILES
|--------------------------------------------------------------------------
*/

const DATA_DIR = path.join(__dirname, "..", "data");

const WHITEOFF_FILE = path.join(
  DATA_DIR,
  "whiteoff.json"
);

let accessToken = null;

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
    throw new Error(
      "Не заданы MOYSKLAD_LOGIN и MOYSKLAD_PASSWORD"
    );
  }

  const credentials = Buffer.from(
    `${MOYSKLAD_LOGIN}:${MOYSKLAD_PASSWORD}`
  ).toString("base64");

  const response = await fetch(
    `${MOYSKLAD_API}/security/token`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        Accept: "application/json;charset=utf-8",
      },
    }
  );

  if (!response.ok) {
    const text = await response.text();

    throw new Error(
      `Ошибка авторизации MoySklad: ${response.status} ${text}`
    );
  }

  const data = await response.json();

  if (!data.access_token) {
    throw new Error(
      "MoySklad не вернул access_token"
    );
  }

  accessToken = data.access_token;

  return accessToken;
}

/*
|--------------------------------------------------------------------------
| MOYSKLAD REQUEST
|--------------------------------------------------------------------------
*/

async function moySkladRequest(
  endpoint,
  options = {},
  retry = true
) {
  const token = await getAccessToken();

  const response = await fetch(
    `${MOYSKLAD_API}${endpoint}`,
    {
      ...options,

      headers: {
        Accept:
          "application/json;charset=utf-8",

        "Content-Type":
          "application/json",

        Authorization:
          `Bearer ${token}`,

        ...(options.headers || {}),
      },
    }
  );

  if (response.status === 401 && retry) {
    accessToken = null;

    return moySkladRequest(
      endpoint,
      options,
      false
    );
  }

  const text = await response.text();

  let data = null;

  try {
    data = text
      ? JSON.parse(text)
      : null;
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

    throw new Error(
      `MoySklad API ${response.status}: ${errorMessage}`
    );
  }

  return data;
}

/*
|--------------------------------------------------------------------------
| DATE HELPERS
|--------------------------------------------------------------------------
*/

function getLocalDateTime() {
  const formatter =
    new Intl.DateTimeFormat(
      "ru-RU",
      {
        timeZone: "Asia/Bishkek",

        year: "numeric",
        month: "2-digit",
        day: "2-digit",

        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",

        hour12: false,
      }
    );

  const parts =
    formatter.formatToParts(
      new Date()
    );

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
  const formatter =
    new Intl.DateTimeFormat(
      "ru-RU",
      {
        timeZone: "Asia/Bishkek",

        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }
    );

  const parts =
    formatter.formatToParts(
      new Date()
    );

  const values = {};

  for (const part of parts) {
    values[part.type] = part.value;
  }

  return (
    `${values.year}-${values.month}-${values.day}`
  );
}

/*
|--------------------------------------------------------------------------
| JSON HELPERS
|--------------------------------------------------------------------------
*/

async function readJsonFile(
  filePath,
  fallback = {}
) {
  try {
    const data =
      await fs.readFile(
        filePath,
        "utf8"
      );

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

async function saveWriteoffToJson(
  writeoff
) {
  await fs.mkdir(
    DATA_DIR,
    {
      recursive: true,
    }
  );

  const data =
    await readJsonFile(
      WHITEOFF_FILE,
      {}
    );

  /*
   * Если файл по какой-то причине
   * оказался массивом — переводим
   * его в нормальную структуру.
   */

  const writeoffs =
    data &&
    typeof data === "object" &&
    !Array.isArray(data)
      ? data
      : {};

  const date =
    writeoff.date ||
    getLocalDate();

  if (!Array.isArray(writeoffs[date])) {
    writeoffs[date] = [];
  }

  writeoffs[date].push(
    writeoff
  );

  await fs.writeFile(
    WHITEOFF_FILE,
    JSON.stringify(
      writeoffs,
      null,
      2
    ),
    "utf8"
  );

  return writeoff;
}

/*
|--------------------------------------------------------------------------
| TYPE
|--------------------------------------------------------------------------
*/

function normalizeType(type) {
  const value = String(
    type || ""
  )
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
  const type =
    normalizeType(item.type);

  const id =
    String(item.id || "").trim();

  if (!id) {
    throw new Error(
      `Не указан id товара: ${
        item.name || "Без названия"
      }`
    );
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

  if (
    item.meta &&
    item.meta.href &&
    item.meta.type
  ) {
    return {
      ...item.meta,
    };
  }

  return {
    href:
      `${MOYSKLAD_API}/entity/${type}/${id}`,

    type,

    mediaType:
      "application/json",
  };
}

/*
|--------------------------------------------------------------------------
| POST /writeoffs
|--------------------------------------------------------------------------
*/

router.post(
  "/writeoffs",
  async (req, res) => {
    try {
      const {
        items,
        reason = "",
        storeId = DEFAULT_STORE_ID,
      } = req.body || {};

      /*
       * Проверяем товары
       */

      if (
        !Array.isArray(items) ||
        items.length === 0
      ) {
        return res.status(400).json({
          success: false,

          message:
            "Для списания необходимо передать товары.",
        });
      }

      /*
       * Нормализуем товары
       */

      const normalizedItems =
        items
          .map((item) => {
            const quantity =
              Math.floor(
                Number(item.quantity)
              );

            if (!item.id) {
              return null;
            }

            if (
              !Number.isFinite(quantity) ||
              quantity <= 0
            ) {
              return null;
            }

            return {
              id: String(item.id),

              name:
                item.name ||
                "Без названия",

              quantity,

              type:
                normalizeType(
                  item.type
                ),

              assortmentMeta:
                item.assortmentMeta ||
                item.meta ||
                null,
            };
          })
          .filter(Boolean);

      if (
        normalizedItems.length === 0
      ) {
        return res.status(400).json({
          success: false,

          message:
            "Нет корректных товаров для списания.",
        });
      }

      /*
       * Получаем организацию
       */

      const organizationResponse =
        await moySkladRequest(
          "/entity/organization?limit=1"
        );

      const organization =
        organizationResponse?.rows?.[0];

      if (!organization?.meta) {
        throw new Error(
          "Не удалось определить организацию MoySklad."
        );
      }

      /*
       * Магазин
       */

      const storeMeta = {
        href:
          `${MOYSKLAD_API}/entity/store/${storeId}`,

        type: "store",

        mediaType:
          "application/json",
      };

      /*
       * Позиции списания
       */

      const positions =
        normalizedItems.map(
          (item) => {
            const position = {
              quantity:
                item.quantity,

              assortment: {
                meta:
                  buildAssortmentMeta(
                    item
                  ),
              },
            };

            /*
             * Причину добавляем,
             * только если она заполнена.
             */

            if (
              reason &&
              String(reason).trim()
            ) {
              position.reason =
                String(reason).trim();
            }

            return position;
          }
        );

      /*
       * Данные для MoySklad
       */

      const payload = {
        name:
          `Списание POS ${getLocalDateTime()}`,

        store: {
          meta: storeMeta,
        },

        organization: {
          meta:
            organization.meta,
        },

        positions,
      };

      /*
       * Сначала создаём списание
       * в MoySklad.
       */

      const result =
        await moySkladRequest(
          "/entity/loss",
          {
            method: "POST",

            body:
              JSON.stringify(
                payload
              ),
          }
        );

      /*
       * MoySklad успешно создал списание.
       *
       * Только после этого сохраняем
       * его локально.
       */

      const createdAt =
        getLocalDateTime();

      const date =
        createdAt.split(" ")[0];

      const writeoffId =
        result?.id ||
        null;

      const writeoff = {
        id:
          writeoffId,

        moyskladId:
          writeoffId,

        moyskladHref:
          result?.meta?.href ||
          null,

        name:
          result?.name ||
          payload.name,

        date,

        createdAt,

        reason:
          String(reason || "").trim(),

        storeId,

        storeName:
          "Молодая Гвардия 41",

        items:
          normalizedItems.map(
            (item) => ({
              id:
                item.id,

              name:
                item.name,

              quantity:
                item.quantity,

              type:
                item.type,
            })
          ),

        /*
         * Сохраняем также количество
         * позиций.
         */

        itemsCount:
          normalizedItems.length,

        totalQuantity:
          normalizedItems.reduce(
            (
              sum,
              item
            ) =>
              sum +
              item.quantity,
            0
          ),
      };

      /*
       * Записываем в:
       *
       * data/whiteoff.json
       */

      await saveWriteoffToJson(
        writeoff
      );

      /*
       * Ответ клиенту
       */

      return res.status(201).json({
        success: true,

        message:
          "Списание успешно создано в MoySklad и сохранено в whiteoff.json.",

        id:
          writeoffId,

        href:
          result?.meta?.href ||
          null,

        date,

        createdAt,

        result,
      });
    } catch (error) {
      console.error(
        "Ошибка создания списания:",
        error
      );

      return res.status(500).json({
        success: false,

        message:
          error?.message ||
          "Ошибка создания списания.",
      });
    }
  }
);

module.exports = router;