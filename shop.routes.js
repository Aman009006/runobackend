const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const router = express.Router();

// backend/../data/productData
const DATA_DIR = path.resolve(__dirname, "..", "data", "productData");

const BACKUP_DIR = path.resolve(
  __dirname,
  "..",
  "data",
  "backups",
  "shop"
);

const FILES = {
  products: "products.json",
  categories: "categories.json",
  slides: "slides.json",
};

function createId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function sendError(res, error, status = 500) {
  console.error("Shop API error:", error);

  return res.status(status).json({
    success: false,
    message: error.message || "Внутренняя ошибка сервера",
  });
}

function getFilePath(collection) {
  const filename = FILES[collection];

  if (!filename) {
    throw new Error("Неизвестная коллекция");
  }

  return path.join(DATA_DIR, filename);
}

async function readCollection(collection) {
  const filePath = getFilePath(collection);
  const content = await fs.readFile(filePath, "utf8");
  const data = JSON.parse(content);

  if (!Array.isArray(data)) {
    throw new Error(`${collection}.json должен содержать массив`);
  }

  return data;
}

async function writeCollection(collection, data) {
  const filePath = getFilePath(collection);

  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(BACKUP_DIR, { recursive: true });

  try {
    const oldContent = await fs.readFile(filePath, "utf8");
    const backupName = `${collection}-${Date.now()}.json`;

    await fs.writeFile(
      path.join(BACKUP_DIR, backupName),
      oldContent,
      "utf8"
    );
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  const tempPath = `${filePath}.${crypto.randomUUID()}.tmp`;

  try {
    await fs.writeFile(
      tempPath,
      JSON.stringify(data, null, 2) + "\n",
      "utf8"
    );

    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.unlink(tempPath).catch(() => {});
    throw error;
  }
}

function validateObject(body) {
  return (
    body !== null &&
    typeof body === "object" &&
    !Array.isArray(body)
  );
}

function validateProduct(product) {
  if (!product.title || !String(product.title).trim()) {
    throw new Error("У товара должно быть название");
  }

  if (
    product.price === undefined ||
    !Number.isFinite(Number(product.price)) ||
    Number(product.price) < 0
  ) {
    throw new Error("Укажите корректную цену товара");
  }

  if (
    product.images !== undefined &&
    (
      !Array.isArray(product.images) ||
      !product.images.every((image) => typeof image === "string")
    )
  ) {
    throw new Error("Поле images должно быть массивом ссылок");
  }

  if (
    product.image !== undefined &&
    typeof product.image !== "string"
  ) {
    throw new Error("Поле image должно быть строкой");
  }
}

function normalizeProduct(product) {
  const images = Array.isArray(product.images)
    ? product.images
    : product.image
      ? [product.image]
      : [];

  return {
    ...product,
    price: Number(product.price),
    images,
    image: product.image || images[0] || "",
  };
}

function validateCategory(category) {
  if (!category.name || !String(category.name).trim()) {
    throw new Error("У категории должно быть название");
  }

  if (!category.id || !String(category.id).trim()) {
    throw new Error("У категории должен быть id");
  }
}

function validateSlide(slide) {
  if (!slide.title || !String(slide.title).trim()) {
    throw new Error("У слайда должен быть заголовок");
  }
}

// GET: все товары
router.get("/products", async (req, res) => {
  try {
    const products = await readCollection("products");

    res.json({
      success: true,
      data: products,
    });
  } catch (error) {
    sendError(res, error);
  }
});

// POST: добавить товар
router.post("/products", async (req, res) => {
  try {
    if (!validateObject(req.body)) {
      return sendError(
        res,
        new Error("Некорректные данные товара"),
        400
      );
    }

    const products = await readCollection("products");
    const categories = await readCollection("categories");

    const product = normalizeProduct({
      ...req.body,
      id: req.body.id || createId("p"),
    });

    validateProduct(product);

    if (
      product.category &&
      !categories.some((category) => category.id === product.category)
    ) {
      return sendError(
        res,
        new Error("Выбранная категория не найдена"),
        400
      );
    }

    if (products.some((item) => item.id === product.id)) {
      return sendError(
        res,
        new Error("Товар с таким id уже существует"),
        409
      );
    }

    products.push(product);
    await writeCollection("products", products);

    res.status(201).json({
      success: true,
      data: product,
    });
  } catch (error) {
    sendError(res, error, 400);
  }
});

// PATCH: изменить товар
router.patch("/products/:id", async (req, res) => {
  try {
    if (!validateObject(req.body)) {
      return sendError(
        res,
        new Error("Некорректные данные товара"),
        400
      );
    }

    const products = await readCollection("products");
    const categories = await readCollection("categories");

    const index = products.findIndex(
      (product) => String(product.id) === req.params.id
    );

    if (index === -1) {
      return sendError(res, new Error("Товар не найден"), 404);
    }

    const updated = normalizeProduct({
      ...products[index],
      ...req.body,
      id: products[index].id,
    });

    validateProduct(updated);

    if (
      updated.category &&
      !categories.some((category) => category.id === updated.category)
    ) {
      return sendError(
        res,
        new Error("Выбранная категория не найдена"),
        400
      );
    }

    products[index] = updated;
    await writeCollection("products", products);

    res.json({
      success: true,
      data: updated,
    });
  } catch (error) {
    sendError(res, error, 400);
  }
});

// DELETE: удалить товар
router.delete("/products/:id", async (req, res) => {
  try {
    const products = await readCollection("products");

    const filtered = products.filter(
      (product) => String(product.id) !== req.params.id
    );

    if (filtered.length === products.length) {
      return sendError(res, new Error("Товар не найден"), 404);
    }

    await writeCollection("products", filtered);

    res.json({ success: true });
  } catch (error) {
    sendError(res, error);
  }
});

// GET: все категории
router.get("/categories", async (req, res) => {
  try {
    const categories = await readCollection("categories");

    res.json({
      success: true,
      data: categories,
    });
  } catch (error) {
    sendError(res, error);
  }
});

// POST: добавить категорию
router.post("/categories", async (req, res) => {
  try {
    if (!validateObject(req.body)) {
      return sendError(
        res,
        new Error("Некорректные данные категории"),
        400
      );
    }

    const categories = await readCollection("categories");

    const category = {
      ...req.body,
      id: req.body.id || createId("category"),
    };

    validateCategory(category);

    if (categories.some((item) => item.id === category.id)) {
      return sendError(
        res,
        new Error("Такая категория уже существует"),
        409
      );
    }

    categories.push(category);
    await writeCollection("categories", categories);

    res.status(201).json({
      success: true,
      data: category,
    });
  } catch (error) {
    sendError(res, error, 400);
  }
});

// PATCH: изменить категорию
router.patch("/categories/:id", async (req, res) => {
  try {
    if (!validateObject(req.body)) {
      return sendError(
        res,
        new Error("Некорректные данные категории"),
        400
      );
    }

    const categories = await readCollection("categories");

    const index = categories.findIndex(
      (category) => String(category.id) === req.params.id
    );

    if (index === -1) {
      return sendError(res, new Error("Категория не найдена"), 404);
    }

    if (req.body.id && req.body.id !== categories[index].id) {
      return sendError(
        res,
        new Error("Изменять id категории нельзя"),
        400
      );
    }

    const updated = {
      ...categories[index],
      ...req.body,
      id: categories[index].id,
    };

    validateCategory(updated);

    categories[index] = updated;
    await writeCollection("categories", categories);

    res.json({
      success: true,
      data: updated,
    });
  } catch (error) {
    sendError(res, error, 400);
  }
});

// DELETE: удалить категорию
router.delete("/categories/:id", async (req, res) => {
  try {
    if (req.params.id === "all") {
      return sendError(
        res,
        new Error("Категорию «Все товары» удалять нельзя"),
        400
      );
    }

    const categories = await readCollection("categories");
    const products = await readCollection("products");

    const exists = categories.some(
      (category) => String(category.id) === req.params.id
    );

    if (!exists) {
      return sendError(res, new Error("Категория не найдена"), 404);
    }

    const used = products.some(
      (product) => String(product.category) === req.params.id
    );

    if (used) {
      return sendError(
        res,
        new Error("Нельзя удалить категорию, в которой есть товары"),
        400
      );
    }

    const filtered = categories.filter(
      (category) => String(category.id) !== req.params.id
    );

    await writeCollection("categories", filtered);

    res.json({ success: true });
  } catch (error) {
    sendError(res, error);
  }
});

// GET: все слайды
router.get("/slides", async (req, res) => {
  try {
    const slides = await readCollection("slides");

    res.json({
      success: true,
      data: slides,
    });
  } catch (error) {
    sendError(res, error);
  }
});

// POST: добавить слайд
router.post("/slides", async (req, res) => {
  try {
    if (!validateObject(req.body)) {
      return sendError(
        res,
        new Error("Некорректные данные слайда"),
        400
      );
    }

    const slides = await readCollection("slides");

    const slide = {
      ...req.body,
      id: req.body.id || createId("slide"),
    };

    validateSlide(slide);

    if (slides.some((item) => item.id === slide.id)) {
      return sendError(
        res,
        new Error("Слайд с таким id уже существует"),
        409
      );
    }

    slides.push(slide);
    await writeCollection("slides", slides);

    res.status(201).json({
      success: true,
      data: slide,
    });
  } catch (error) {
    sendError(res, error, 400);
  }
});

// PATCH: изменить слайд
router.patch("/slides/:id", async (req, res) => {
  try {
    if (!validateObject(req.body)) {
      return sendError(
        res,
        new Error("Некорректные данные слайда"),
        400
      );
    }

    const slides = await readCollection("slides");

    const index = slides.findIndex(
      (slide) => String(slide.id) === req.params.id
    );

    if (index === -1) {
      return sendError(res, new Error("Слайд не найден"), 404);
    }

    const updated = {
      ...slides[index],
      ...req.body,
      id: slides[index].id,
    };

    validateSlide(updated);

    slides[index] = updated;
    await writeCollection("slides", slides);

    res.json({
      success: true,
      data: updated,
    });
  } catch (error) {
    sendError(res, error, 400);
  }
});

// DELETE: удалить слайд
router.delete("/slides/:id", async (req, res) => {
  try {
    const slides = await readCollection("slides");

    const filtered = slides.filter(
      (slide) => String(slide.id) !== req.params.id
    );

    if (filtered.length === slides.length) {
      return sendError(res, new Error("Слайд не найден"), 404);
    }

    await writeCollection("slides", filtered);

    res.json({ success: true });
  } catch (error) {
    sendError(res, error);
  }
});

// =========================================================
// RUNO SHOP ORDERS + SEPARATE TELEGRAM BOT
// Environment:
// RUNO_ORDERS_BOT_TOKEN
// RUNO_ORDERS_CHAT_ID
// RUNO_ORDERS_WEBHOOK_SECRET
// =========================================================

const SHOP_ORDERS_FILE = path.resolve(
  __dirname,
  "..",
  "data",
  "shopOrders.json"
);

let shopOrdersQueue = Promise.resolve();

function withShopOrdersLock(task) {
  const result = shopOrdersQueue.then(task, task);
  shopOrdersQueue = result.catch(() => {});
  return result;
}

async function readShopOrders() {
  await fs.mkdir(path.dirname(SHOP_ORDERS_FILE), { recursive: true });

  try {
    const content = await fs.readFile(SHOP_ORDERS_FILE, "utf8");
    const orders = JSON.parse(content);
    return Array.isArray(orders) ? orders : [];
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function writeShopOrders(orders) {
  await fs.mkdir(path.dirname(SHOP_ORDERS_FILE), { recursive: true });

  const tempPath = `${SHOP_ORDERS_FILE}.${crypto.randomUUID()}.tmp`;

  try {
    await fs.writeFile(
      tempPath,
      JSON.stringify(orders, null, 2),
      "utf8"
    );

    await fs.rename(tempPath, SHOP_ORDERS_FILE);
  } catch (error) {
    await fs.unlink(tempPath).catch(() => {});
    throw error;
  }
}

function escapeTelegramHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function callRunoOrdersTelegram(method, payload) {
  const token = process.env.RUNO_ORDERS_BOT_TOKEN;

  if (!token) {
    throw new Error("RUNO_ORDERS_BOT_TOKEN не указан в .env");
  }

  const response = await fetch(
    `https://api.telegram.org/bot${token}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }
  );

  const result = await response.json().catch(() => ({}));

  if (!response.ok || !result.ok) {
    throw new Error(
      result.description || `Telegram API error: ${response.status}`
    );
  }

  return result.result;
}

// POST /api/shop/orders — оформление заказа с сайта
router.post("/orders", async (req, res) => {
  try {
    const botToken = process.env.RUNO_ORDERS_BOT_TOKEN;
    const chatId = process.env.RUNO_ORDERS_CHAT_ID;

    if (!botToken || !chatId) {
      return res.status(500).json({
        success: false,
        message: "Бот заказов RUNO ещё не настроен на сервере",
      });
    }

    const name = String(req.body?.name || "").trim();
    const phone = String(req.body?.phone || "").trim();
    const address = String(req.body?.address || "").trim();
    const rawItems = req.body?.items;

    if (name.length < 2 || name.length > 80) {
      return res.status(400).json({
        success: false,
        message: "Укажите имя от 2 до 80 символов",
      });
    }

    const normalizedPhone = phone.replace(/[^\d+]/g, "");
    const phoneDigits = normalizedPhone.replace(/\D/g, "");

    if (phoneDigits.length < 9 || phoneDigits.length > 15) {
      return res.status(400).json({
        success: false,
        message: "Укажите корректный номер телефона",
      });
    }
    if (address.length < 5 || address.length > 300) {
  return res.status(400).json({
    success: false,
    message: "Укажите корректный адрес доставки",
  });
}

    if (
      !Array.isArray(rawItems) ||
      rawItems.length === 0 ||
      rawItems.length > 30
    ) {
      return res.status(400).json({
        success: false,
        message: "Корзина пуста или содержит слишком много позиций",
      });
    }

    // Берём названия и цены из серверного каталога,
    // а не доверяем сумме и ценам, присланным браузером.
    const products = await readCollection("products");

    const items = rawItems.map((rawItem) => {
      const product = products.find(
        (item) => String(item.id) === String(rawItem.id)
      );

      const quantity = Number(rawItem.quantity);

      if (!product) {
        throw new Error("Один из товаров больше недоступен");
      }

      if (
        !Number.isInteger(quantity) ||
        quantity < 1 ||
        quantity > 99
      ) {
        throw new Error("Некорректное количество товара");
      }

      const price = Number(product.price);

      if (!Number.isFinite(price) || price < 0) {
        throw new Error(
          `Некорректная цена товара ${product.title || ""}`
        );
      }

      return {
        id: String(product.id),
        title: String(product.title || product.titleKg || "Товар"),
        price,
        quantity,
        lineTotal: price * quantity,
      };
    });

    const total = items.reduce(
      (sum, item) => sum + item.lineTotal,
      0
    );

    const orderId = createId("runo-order");
    const createdAt = new Date().toISOString();

  const order = {
  id: orderId,
  name,
  phone: normalizedPhone,
  address,
  items,
  total,
  status: "new",
  createdAt,
  telegramChatId: String(chatId),
  telegramMessageId: null,
};

    // Сохраняем заказ до отправки сообщения в Telegram.
    await withShopOrdersLock(async () => {
      const orders = await readShopOrders();
      orders.push(order);
      await writeShopOrders(orders);
    });

const shopUrl = (
  process.env.RUNO_SHOP_URL || "https://runo.kg"
).replace(/\/+$/, "");

const formattedItems = items
  .map((item, index) => {
    const lineTotal = new Intl.NumberFormat("ru-RU")
      .format(item.lineTotal);

    const productUrl =
      `${shopUrl}/product/${encodeURIComponent(item.id)}`;

    return (
      `${index + 1}. <b>${escapeTelegramHtml(item.title)}</b>\n` +
      `   ${item.quantity} × ${new Intl.NumberFormat("ru-RU").format(item.price)} сом = ${lineTotal} сом\n` +
      `   🔗 <a href="${escapeTelegramHtml(productUrl)}">Открыть товар</a>`
    );
  })
  .join("\n\n");

 const formattedTotal = new Intl.NumberFormat("ru-RU")
  .format(total);

const message =
  `🛍 <b>НОВЫЙ ЗАКАЗ RUNO</b>\n\n` +
  `🆔 <b>Заказ:</b> ${escapeTelegramHtml(orderId)}\n` +
  `👤 <b>Имя:</b> ${escapeTelegramHtml(name)}\n` +
  `📞 <b>Телефон:</b> ${escapeTelegramHtml(normalizedPhone)}\n` +
  `📍 <b>Адрес доставки:</b> ${escapeTelegramHtml(address)}\n\n` +
  `📦 <b>Товары:</b>\n\n${formattedItems}\n\n` +
  `💰 <b>Итого:</b> ${formattedTotal} сом`;

    try {
      const telegramMessage = await callRunoOrdersTelegram(
        "sendMessage",
        {
          chat_id: chatId,
          text: message,
          parse_mode: "HTML",
          disable_web_page_preview: true,
         reply_markup: {
  inline_keyboard: [
    ...items.map((item) => [
      {
        text: `🛍 Открыть: ${item.title.slice(0, 35)}`,
        url: `${shopUrl}/product/${encodeURIComponent(item.id)}`,
      },
    ])
  ],
},
        }
      );

      await withShopOrdersLock(async () => {
        const orders = await readShopOrders();
        const index = orders.findIndex(
          (item) => item.id === orderId
        );

        if (index !== -1) {
          orders[index].telegramMessageId =
            telegramMessage.message_id;

          await writeShopOrders(orders);
        }
      });
    } catch (telegramError) {
      await withShopOrdersLock(async () => {
        const orders = await readShopOrders();
        const index = orders.findIndex(
          (item) => item.id === orderId
        );

        if (index !== -1) {
          orders[index].status = "telegram_error";
          orders[index].telegramError = telegramError.message;
          await writeShopOrders(orders);
        }
      });

      throw telegramError;
    }

    return res.status(201).json({
      success: true,
      message: "Заказ отправлен продавцам RUNO",
      orderId,
    });
  } catch (error) {
    console.error("RUNO SHOP ORDER ERROR:", error);

    return res.status(400).json({
      success: false,
      message: error.message || "Не удалось оформить заказ",
    });
  }
});

// POST /api/shop/orders/telegram-webhook — нажатия кнопки продавцами
router.post("/orders/telegram-webhook", async (req, res) => {
  const expectedSecret = process.env.RUNO_ORDERS_WEBHOOK_SECRET;
  const receivedSecret = req.get(
    "X-Telegram-Bot-Api-Secret-Token"
  );

  if (!expectedSecret || receivedSecret !== expectedSecret) {
    return res.sendStatus(401);
  }

  // Telegram ждёт быстрый HTTP 200, в том числе для ненужных update.
  res.sendStatus(200);

  const callback = req.body?.callback_query;
  if (!callback) return;

  const callbackData = String(callback.data || "");
  const orderId = callbackData.startsWith("claim:")
    ? callbackData.slice("claim:".length)
    : "";

  if (!orderId || !callback.from?.id || !callback.message?.chat?.id) {
    return;
  }

  const configuredChatId = String(
    process.env.RUNO_ORDERS_CHAT_ID || ""
  );

  const callbackChatId = String(callback.message.chat.id);

  if (!configuredChatId || callbackChatId !== configuredChatId) {
    await callRunoOrdersTelegram("answerCallbackQuery", {
      callback_query_id: callback.id,
      text: "Эта кнопка не относится к группе заказов RUNO",
      show_alert: true,
    }).catch((error) => {
      console.error("Telegram callback answer error:", error);
    });

    return;
  }

  const username = callback.from.username
    ? `@${callback.from.username}`
    : [
        callback.from.first_name,
        callback.from.last_name,
      ]
        .filter(Boolean)
        .join(" ") || `ID ${callback.from.id}`;

  let claimResult;

  try {
    claimResult = await withShopOrdersLock(async () => {
      const orders = await readShopOrders();

      const index = orders.findIndex(
        (item) => item.id === orderId
      );

      if (index === -1) {
        return { found: false };
      }

      const order = orders[index];

      if (order.status === "claimed") {
        return {
          found: true,
          alreadyClaimed: true,
          claimedBy: order.claimedBy,
        };
      }

      if (order.status !== "new") {
        return {
          found: true,
          unavailable: true,
        };
      }

      order.status = "claimed";
      order.claimedBy = username;
      order.claimedByTelegramId = String(callback.from.id);
      order.claimedAt = new Date().toISOString();

      await writeShopOrders(orders);

      return {
        found: true,
        claimed: true,
        claimedBy: username,
        order,
      };
    });

    if (!claimResult.found) {
      await callRunoOrdersTelegram("answerCallbackQuery", {
        callback_query_id: callback.id,
        text: "Заказ не найден",
        show_alert: true,
      });

      return;
    }

    if (claimResult.alreadyClaimed) {
      await callRunoOrdersTelegram("answerCallbackQuery", {
        callback_query_id: callback.id,
        text: `Клиента уже забрал ${claimResult.claimedBy}`,
        show_alert: true,
      });

      return;
    }

    if (claimResult.unavailable) {
      await callRunoOrdersTelegram("answerCallbackQuery", {
        callback_query_id: callback.id,
        text: "Этот заказ сейчас недоступен",
        show_alert: true,
      });

      return;
    }

    await callRunoOrdersTelegram("answerCallbackQuery", {
      callback_query_id: callback.id,
      text: "Клиент закреплён за вами",
    });

    const originalText = callback.message.text || "";

    const updatedText =
      `${originalText}\n\n✅ <b>Клиента забрал:</b> ${escapeTelegramHtml(username)}`;

    await callRunoOrdersTelegram("editMessageText", {
      chat_id: callbackChatId,
      message_id: callback.message.message_id,
      text: updatedText,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [],
      },
    });
  } catch (error) {
    console.error("RUNO ORDER CLAIM ERROR:", error);

    await callRunoOrdersTelegram("answerCallbackQuery", {
      callback_query_id: callback.id,
      text: "Не удалось закрепить заказ. Попробуйте ещё раз",
      show_alert: true,
    }).catch((answerError) => {
      console.error("Telegram callback answer error:", answerError);
    });
  }
});

module.exports = router;