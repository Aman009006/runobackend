const { WebSocketServer } = require("ws");

const rooms = new Map(); // key -> { cashiers:Set, displays:Set, cart, payment }

const EMPTY_CART = { isOpen: false, items: [], total: 0 };
const EMPTY_PAYMENT = { status: "idle", qrCode: "", amount: 0, paymentId: "" };

const ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

const toNumber = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

function normalizeCart(s = {}) {
  return {
    isOpen: Boolean(s.isOpen),
    items: Array.isArray(s.items)
      ? s.items.slice(0, 100).map((i) => ({
          id: String(i.id || ""),
          name: String(i.name || "Без названия").slice(0, 200),
          price: toNumber(i.price),
          quantity: Math.max(0, toNumber(i.quantity)),
        }))
      : [],
    total: toNumber(s.total),
  };
}

function normalizePayment(s = {}) {
  const allowed = ["idle", "pending", "success", "failed"];
  return {
    status: allowed.includes(s.status) ? s.status : "idle",
    qrCode: typeof s.qrCode === "string" ? s.qrCode.slice(0, 50000) : "",
    amount: toNumber(s.amount),
    paymentId: String(s.paymentId || "").slice(0, 200),
  };
}

function getRoom(key) {
  if (!rooms.has(key)) {
    rooms.set(key, {
      cashiers: new Set(),
      displays: new Set(),
      cart: EMPTY_CART,
      payment: EMPTY_PAYMENT,
    });
  }
  return rooms.get(key);
}

function send(ws, data) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(data));
}

const cartMsg = (cart) => ({ type: "CART_UPDATE", ...cart });
const paymentMsg = (p) => ({ type: "PAYMENT_UPDATE", ...p });

function attachOnlineCashSocket(server) {
  const wss = new WebSocketServer({ server, path: "/ws/online-cash" });

  wss.on("connection", (ws, req) => {
    const url = new URL(req.url, "http://localhost");
    const role = url.searchParams.get("role");
    const branchId = (url.searchParams.get("branchId") || "").trim();
    const terminalId = (url.searchParams.get("terminalId") || "main").trim();

    if (
      !["cashier", "display"].includes(role) ||
      !ID_RE.test(branchId) ||
      !ID_RE.test(terminalId)
    ) {
      ws.close(1008, "bad params");
      return;
    }

    const key = `${branchId.toLowerCase()}:${terminalId}`;
    const room = getRoom(key);

    ws.isAlive = true;
    ws.on("pong", () => (ws.isAlive = true));

    if (role === "display") {
      room.displays.add(ws);
      // сразу отдаём текущее состояние
      send(ws, cartMsg(room.cart));
      send(ws, paymentMsg(room.payment));
    } else {
      room.cashiers.add(ws);
    }

    ws.on("message", (raw) => {
      if (role !== "cashier") return; // только касса может писать

      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }

      if (msg.type === "cart") {
        room.cart = normalizeCart(msg.state);
        room.displays.forEach((d) => send(d, cartMsg(room.cart)));
      } else if (msg.type === "payment") {
        room.payment = normalizePayment(msg.state);
        room.displays.forEach((d) => send(d, paymentMsg(room.payment)));
      }
    });

    ws.on("close", () => {
      room.cashiers.delete(ws);
      room.displays.delete(ws);

      // касса закрылась — очищаем экран покупателя
      if (role === "cashier" && room.cashiers.size === 0) {
        room.cart = EMPTY_CART;
        room.payment = EMPTY_PAYMENT;
        room.displays.forEach((d) => {
          send(d, cartMsg(room.cart));
          send(d, paymentMsg(room.payment));
        });
      }

      if (!room.cashiers.size && !room.displays.size) rooms.delete(key);
    });
  });

  // убираем «мёртвые» соединения
  const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    });
  }, 25000);

  wss.on("close", () => clearInterval(interval));
}

module.exports = { attachOnlineCashSocket };