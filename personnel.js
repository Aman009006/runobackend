const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const { getCurrentBranch } = require("./branchContext");

const router = express.Router();

/*
|--------------------------------------------------------------------------
| FILE
|--------------------------------------------------------------------------
*/

const DATA_DIR = path.join(__dirname, "..", "data");

const PERSONNEL_FILE = path.join(DATA_DIR, "personnel.json");

/*
|--------------------------------------------------------------------------
| HELPERS
|--------------------------------------------------------------------------
*/

/**
 * Получить ключ текущего филиала.
 *
 * Ожидается, что getCurrentBranch() возвращает что-то вроде:
 *
 * {
 *   id: "bishkek",
 *   ...
 * }
 *
 * или:
 *
 * {
 *   id: "dordoy",
 *   ...
 * }
 */
function getBranchKey() {
  const branch = getCurrentBranch();

  if (!branch?.id) {
    throw new Error("Текущий филиал не определён.");
  }

  return String(branch.id).trim().toLowerCase();
}

/**
 * Прочитать весь personnel.json
 *
 * Формат:
 *
 * {
 *   "bishkek": [],
 *   "dordoy": [],
 *   "osh": []
 * }
 */
async function readPersonnelData() {
  try {
    const data = await fs.readFile(PERSONNEL_FILE, "utf8");

    if (!data.trim()) {
      return {};
    }

    const parsed = JSON.parse(data);

    /*
     * Защита от старого формата:
     *
     * [
     *   { id: "...", name: "..." }
     * ]
     *
     * Если вдруг старый JSON ещё остался,
     * не ломаем приложение.
     */
    if (Array.isArray(parsed)) {
      return {
        bishkek: parsed,
      };
    }

    if (!parsed || typeof parsed !== "object") {
      return {};
    }

    return parsed;
  } catch (error) {
    if (error.code === "ENOENT") {
      await fs.mkdir(DATA_DIR, {
        recursive: true,
      });

      const emptyData = {
        bishkek: [],
        dordoy: [],
        osh: [],
      };

      await fs.writeFile(
        PERSONNEL_FILE,
        JSON.stringify(emptyData, null, 2),
        "utf8",
      );

      return emptyData;
    }

    throw error;
  }
}

/**
 * Сохранить весь personnel.json
 */
async function savePersonnelData(data) {
  await fs.mkdir(DATA_DIR, {
    recursive: true,
  });

  await fs.writeFile(PERSONNEL_FILE, JSON.stringify(data, null, 2), "utf8");
}

/**
 * Получить сотрудников текущего филиала
 */
async function readPersonnel() {
  const branchKey = getBranchKey();

  const data = await readPersonnelData();

  if (!Array.isArray(data[branchKey])) {
    data[branchKey] = [];
  }

  return data[branchKey];
}

/*
|--------------------------------------------------------------------------
| GET /api/personnel
|--------------------------------------------------------------------------
|
| Получить персонал текущего филиала
|
*/

router.get("/personnel", async (req, res) => {
  try {
    const branchKey = getBranchKey();

    const data = await readPersonnelData();

    if (!Array.isArray(data[branchKey])) {
      data[branchKey] = [];

      await savePersonnelData(data);
    }

    return res.json({
      success: true,
      branch: branchKey,
      personnel: data[branchKey],
    });
  } catch (error) {
    console.error("Ошибка получения персонала:", error);

    return res.status(500).json({
      success: false,
      message: "Не удалось получить персонал.",
    });
  }
});

/*
|--------------------------------------------------------------------------
| POST /api/personnel
|--------------------------------------------------------------------------
|
| Добавить сотрудника
|
| body:
|
| {
|   "name": "Айгуль"
| }
|
*/

router.post("/personnel", async (req, res) => {
  try {
    const branchKey = getBranchKey();

    const name = String(req.body?.name || "").trim();

    if (!name) {
      return res.status(400).json({
        success: false,
        message: "Введите имя сотрудника.",
      });
    }

    const data = await readPersonnelData();

    /*
     * Если филиала ещё нет
     * в JSON — создаём его.
     */

    if (!Array.isArray(data[branchKey])) {
      data[branchKey] = [];
    }

    const personnel = data[branchKey];

    /*
     * Не разрешаем добавить
     * одинаковое имя в одном филиале.
     */

    const alreadyExists = personnel.some(
      (person) =>
        String(person.name || "")
          .trim()
          .toLowerCase() === name.toLowerCase(),
    );

    if (alreadyExists) {
      return res.status(409).json({
        success: false,
        message: "Сотрудник с таким именем уже существует.",
      });
    }

    /*
     * Генерируем ID.
     */

    const person = {
      id: `seller_${crypto.randomUUID()}`,
      name,
    };

    /*
     * Добавляем сотрудника
     * только в текущий филиал.
     */

    data[branchKey].push(person);

    await savePersonnelData(data);

    return res.status(201).json({
      success: true,
      message: "Сотрудник успешно добавлен.",
      branch: branchKey,
      person,
      personnel: data[branchKey],
    });
  } catch (error) {
    console.error("Ошибка добавления персонала:", error);

    return res.status(500).json({
      success: false,
      message: "Не удалось добавить сотрудника.",
    });
  }
});

/*
|--------------------------------------------------------------------------
| DELETE /api/personnel/:id
|--------------------------------------------------------------------------
|
| Удалить сотрудника
|
*/

router.delete("/personnel/:id", async (req, res) => {
  try {
    const branchKey = getBranchKey();

    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        success: false,
        message: "Не указан ID сотрудника.",
      });
    }

    const data = await readPersonnelData();

    /*
     * Если текущего филиала нет,
     * сотрудника соответственно тоже нет.
     */

    if (!Array.isArray(data[branchKey])) {
      data[branchKey] = [];
    }

    const personnel = data[branchKey];

    const person = personnel.find((item) => item.id === id);

    if (!person) {
      return res.status(404).json({
        success: false,
        message: "Сотрудник не найден.",
      });
    }

    /*
     * Удаляем только из текущего филиала.
     */

    const newPersonnel = personnel.filter((item) => item.id !== id);

    data[branchKey] = newPersonnel;

    await savePersonnelData(data);

    return res.json({
      success: true,
      message: "Сотрудник успешно удалён.",
      branch: branchKey,
      deletedId: id,
      personnel: newPersonnel,
    });
  } catch (error) {
    console.error("Ошибка удаления персонала:", error);

    return res.status(500).json({
      success: false,
      message: "Не удалось удалить сотрудника.",
    });
  }
});

module.exports = router;
