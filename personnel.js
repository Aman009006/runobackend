const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const router = express.Router();

/*
|--------------------------------------------------------------------------
| FILE
|--------------------------------------------------------------------------
*/

const DATA_DIR = path.join(
  __dirname,
  "..",
  "data"
);

const PERSONNEL_FILE = path.join(
  DATA_DIR,
  "personnel.json"
);

/*
|--------------------------------------------------------------------------
| HELPERS
|--------------------------------------------------------------------------
*/

async function readPersonnel() {
  try {
    const data = await fs.readFile(
      PERSONNEL_FILE,
      "utf8"
    );

    if (!data.trim()) {
      return [];
    }

    const parsed = JSON.parse(data);

    return Array.isArray(parsed)
      ? parsed
      : [];
  } catch (error) {
    if (error.code === "ENOENT") {
      await fs.mkdir(DATA_DIR, {
        recursive: true,
      });

      await fs.writeFile(
        PERSONNEL_FILE,
        "[]",
        "utf8"
      );

      return [];
    }

    throw error;
  }
}

async function savePersonnel(personnel) {
  await fs.mkdir(DATA_DIR, {
    recursive: true,
  });

  await fs.writeFile(
    PERSONNEL_FILE,
    JSON.stringify(
      personnel,
      null,
      2
    ),
    "utf8"
  );
}

/*
|--------------------------------------------------------------------------
| GET /api/personnel
|--------------------------------------------------------------------------
|
| Получить весь персонал
|
*/

router.get(
  "/personnel",
  async (req, res) => {
    try {
      const personnel =
        await readPersonnel();

      return res.json({
        success: true,
        personnel,
      });
    } catch (error) {
      console.error(
        "Ошибка получения персонала:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "Не удалось получить персонал.",
      });
    }
  }
);

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

router.post(
  "/personnel",
  async (req, res) => {
    try {
      const name = String(
        req.body?.name || ""
      ).trim();

      if (!name) {
        return res.status(400).json({
          success: false,
          message:
            "Введите имя сотрудника.",
        });
      }

      const personnel =
        await readPersonnel();

      /*
       * Не разрешаем добавить
       * одинаковое имя.
       */

      const alreadyExists =
        personnel.some(
          (person) =>
            String(
              person.name || ""
            )
              .trim()
              .toLowerCase() ===
            name.toLowerCase()
        );

      if (alreadyExists) {
        return res.status(409).json({
          success: false,
          message:
            "Сотрудник с таким именем уже существует.",
        });
      }

      /*
       * Генерируем ID.
       */

      const person = {
        id:
          `seller_${crypto.randomUUID()}`,
        name,
      };

      personnel.push(person);

      await savePersonnel(
        personnel
      );

      return res.status(201).json({
        success: true,
        message:
          "Сотрудник успешно добавлен.",
        person,
        personnel,
      });
    } catch (error) {
      console.error(
        "Ошибка добавления персонала:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "Не удалось добавить сотрудника.",
      });
    }
  }
);

/*
|--------------------------------------------------------------------------
| DELETE /api/personnel/:id
|--------------------------------------------------------------------------
|
| Удалить сотрудника
|
*/

router.delete(
  "/personnel/:id",
  async (req, res) => {
    try {
      const { id } = req.params;

      if (!id) {
        return res.status(400).json({
          success: false,
          message:
            "Не указан ID сотрудника.",
        });
      }

      const personnel =
        await readPersonnel();

      const person =
        personnel.find(
          (item) =>
            item.id === id
        );

      if (!person) {
        return res.status(404).json({
          success: false,
          message:
            "Сотрудник не найден.",
        });
      }

      const newPersonnel =
        personnel.filter(
          (item) =>
            item.id !== id
        );

      await savePersonnel(
        newPersonnel
      );

      return res.json({
        success: true,
        message:
          "Сотрудник успешно удалён.",
        deletedId: id,
        personnel:
          newPersonnel,
      });
    } catch (error) {
      console.error(
        "Ошибка удаления персонала:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "Не удалось удалить сотрудника.",
      });
    }
  }
);

module.exports = router;