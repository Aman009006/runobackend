const express = require("express");
const crypto = require("crypto");

const {
  findBranchByCredentials,
  getBranchById,
} = require("./branches");

const {
  runWithBranch,
} = require("./branchContext");

const router = express.Router();

const AUTH_COOKIE_NAME = "runo_auth";

const AUTH_SECRET =
  process.env.AUTH_SECRET ||
  crypto.randomBytes(32).toString("hex");

const SESSION_DURATION = 24 * 60 * 60 * 1000;

function createAuthToken(branchId) {
  const expiresAt = Date.now() + SESSION_DURATION;

  const payload = `${branchId}.${expiresAt}`;

  const signature = crypto
    .createHmac("sha256", AUTH_SECRET)
    .update(payload)
    .digest("hex");

  return `${payload}.${signature}`;
}

function verifyAuthToken(token) {
  if (!token) {
    return null;
  }

  const parts = token.split(".");

  if (parts.length !== 3) {
    return null;
  }

  const [branchId, expiresAtString, signature] = parts;

  const branch = getBranchById(branchId);

  if (!branch) {
    return null;
  }

  const expiresAt = Number(expiresAtString);

  if (!Number.isFinite(expiresAt)) {
    return null;
  }

  if (expiresAt < Date.now()) {
    return null;
  }

  const payload = `${branchId}.${expiresAt}`;

  const expectedSignature = crypto
    .createHmac("sha256", AUTH_SECRET)
    .update(payload)
    .digest("hex");

  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);

  if (
    actualBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(
      actualBuffer,
      expectedBuffer
    )
  ) {
    return null;
  }

  return {
    branch,
    branchId,
    expiresAt,
  };
}

function getCookie(req, name) {
  const cookieHeader = req.headers.cookie;

  if (!cookieHeader) {
    return null;
  }

  const cookies = cookieHeader.split(";");

  for (const cookie of cookies) {
    const [key, ...valueParts] = cookie.trim().split("=");

    if (key === name) {
      const value = valueParts.join("=");

      try {
        return decodeURIComponent(value);
      } catch {
        return null;
      }
    }
  }

  return null;
}

function setAuthCookie(res, token) {
  const isProduction =
    process.env.NODE_ENV === "production";

  const cookie = [
    `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "HttpOnly",
    "Path=/",
    `Max-Age=${SESSION_DURATION / 1000}`,
    `SameSite=${isProduction ? "None" : "Lax"}`,
  ];

  if (isProduction) {
    cookie.push("Secure");
  }

  res.setHeader(
    "Set-Cookie",
    cookie.join("; ")
  );
}

function clearAuthCookie(res) {
  const isProduction =
    process.env.NODE_ENV === "production";

  const cookie = [
    `${AUTH_COOKIE_NAME}=`,
    "HttpOnly",
    "Path=/",
    "Max-Age=0",
    `SameSite=${isProduction ? "None" : "Lax"}`,
  ];

  if (isProduction) {
    cookie.push("Secure");
  }

  res.setHeader(
    "Set-Cookie",
    cookie.join("; ")
  );
}

/**
 * POST /api/auth/login
 */
router.post("/login", (req, res) => {
  try {
    const { login, password } = req.body;

    if (!login || !password) {
      return res.status(400).json({
        success: false,
        message: "Введите логин и пароль",
      });
    }

    const branch = findBranchByCredentials(
      login,
      password
    );

    if (!branch) {
      return res.status(401).json({
        success: false,
        message: "Неверный логин или пароль",
      });
    }

    const token = createAuthToken(branch.id);

    setAuthCookie(res, token);

    return res.json({
      success: true,

      branch: {
        id: branch.id,
        name: branch.name,
      },
    });
  } catch (error) {
    console.error(
      "Ошибка авторизации:",
      error
    );

    return res.status(500).json({
      success: false,
      message: "Ошибка авторизации",
    });
  }
});

/**
 * GET /api/auth/me
 */
router.get("/me", (req, res) => {
  const token = getCookie(
    req,
    AUTH_COOKIE_NAME
  );

  const session = verifyAuthToken(token);

  if (!session) {
    return res.status(401).json({
      success: false,
      message: "Не авторизован",
    });
  }

  return res.json({
    success: true,

    branch: {
      id: session.branch.id,
      name: session.branch.name,
    },
  });
});

/**
 * POST /api/auth/logout
 */
router.post("/logout", (req, res) => {
  clearAuthCookie(res);

  return res.json({
    success: true,
  });
});

/**
 * Защита API
 */
function requireAuth(req, res, next) {
  if (req.method === "OPTIONS") {
    return next();
  }

  const token = getCookie(
    req,
    AUTH_COOKIE_NAME
  );

  const session = verifyAuthToken(token);

  if (!session) {
    return res.status(401).json({
      success: false,
      message: "Требуется авторизация",
    });
  }

  req.branch = session.branch;
  req.branchId = session.branchId;

  runWithBranch(
    session.branch,
    () => next()
  );
}

module.exports = {
  router,
  requireAuth,
  verifyAuthToken,
  getCookie,
};