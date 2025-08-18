// server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { createServer } from "http";
import { Server } from "socket.io";
import rateLimit from "express-rate-limit";
import { connectMongo } from "./db/mongo.js";
import {
  clients,
  getOrCreateClient,
  getClient,
  logoutClient,
  sendMessageSafe,
  restartClient,
} from "./sessions/sessionManager.js";

dotenv.config();

const app = express();

// *** Estás detrás de Caddy: confía en el proxy para X-Forwarded-For
app.set("trust proxy", 1);

// CORS (ajusta si quieres restringir a tu frontend)
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "*";
app.use(
  cors({
    origin: FRONTEND_ORIGIN,
  })
);

app.use(express.json());

// --- Seguridad simple por API key (HTTP) ---
const API_KEY = process.env.API_KEY || "apiwhatsappzybi";

app.use((req, res, next) => {
  const key = req.header("x-api-key");
  if (!key || key !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

// --- Rate limit básico (respetando proxy) ---
const limiter = rateLimit({
  windowMs: 60_000, // ventana 1 minuto
  max: 300, // límite público
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    const ip = req.ip || req.connection?.remoteAddress || "";
    const key = req.header("x-api-key");

    // Whitelist: loopback, tu IP pública, o si usa la API_KEY
    return (
      ip === "127.0.0.1" ||
      ip === "::1" ||
      ip === "45.32.163.233" ||
      key === API_KEY
    );
  },
});

app.use(limiter);

const httpServer = createServer(app);

// --- Socket.IO con auth via handshake (los browsers no pueden mandar headers arbitrarios) ---
const io = new Server(httpServer, {
  cors: { origin: FRONTEND_ORIGIN },
});

io.use((socket, next) => {
  const key =
    socket.handshake.auth?.apiKey || socket.handshake.headers["x-api-key"];
  if (key && key === API_KEY) return next();
  next(new Error("unauthorized"));
});

// --- Mongo ---
connectMongo()
  .then(() => console.log("✅ MongoDB conectado"))
  .catch((e) => console.error("❌ Error Mongo:", e.message));

// --- Healthcheck sencillo (útil para Caddy/monitoring) ---
app.get("/health", (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// --- Crear/reusar sesión ---
app.post("/api/session", (req, res) => {
  const { clientId } = req.body;
  if (!clientId) return res.status(400).json({ error: "Falta clientId" });
  getOrCreateClient({ clientId, io });
  res.json({ status: "pending", clientId });
});

// --- Enviar mensaje (texto o imagen) con reintento seguro ---
app.post("/api/send", async (req, res) => {
  const { clientId, phone, message, image } = req.body;
  if (!clientId || !phone || (!message && !image)) {
    return res
      .status(400)
      .json({ error: "Faltan datos: mínimo mensaje o imagen" });
  }
  const client = getClient(clientId);
  if (!client) return res.status(404).json({ error: "Sesión no encontrada" });

  try {
    const result = await sendMessageSafe(clientId, { phone, message, image });
    res.json({ status: "sent", ...result });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

// --- Logout y borrado de credenciales (requiere re-escanear) ---
app.post("/api/logout", (req, res) => {
  const { clientId } = req.body;
  if (!clientId) return res.status(400).json({ error: "Falta clientId" });
  logoutClient(clientId, io);
  res.json({ status: "logout", clientId });
});

// --- Reiniciar sesión sin perder login (reinit del cliente) ---
app.post("/api/restart", async (req, res) => {
  const { clientId } = req.body;
  if (!clientId) return res.status(400).json({ error: "Falta clientId" });
  try {
    await restartClient(clientId, io);
    res.json({ status: "restarting", clientId });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// --- Listar sesiones en memoria ---
app.get("/api/sessions", (_req, res) => {
  const list = Object.keys(clients).map((clientId) => {
    const c = clients[clientId];
    return {
      clientId,
      status: c.__status || "pending", // 'connecting' | 'waiting_qr' | 'ready' | ...
      reason: c.__reason || "",
      lastReadyAt: c.__lastReadyAt || 0,
      lastQrAt: c.__lastQrAt || 0,
    };
  });
  res.json(list);
});

// --- Status de una sesión específica (útil para sincronizar UI al refrescar) ---
app.get("/api/status/:clientId", async (req, res) => {
  const { clientId } = req.params;
  const c = getClient(clientId);
  if (!c) return res.json({ code: "disconnected", reason: "not_found" });
  try {
    const st = await c.getState().catch(() => "UNKNOWN");
    const code = c.__ready
      ? "ready"
      : c.__status || (st === "CONNECTED" ? "authenticated" : "disconnected");
    res.json({
      code,
      reason: c.__reason || "",
      wweb_state: st,
      lastReadyAt: c.__lastReadyAt || 0,
      lastQrAt: c.__lastQrAt || 0,
    });
  } catch (e) {
    res.json({ code: "disconnected", reason: e.message || "unknown" });
  }
});

// --- WebSockets: sala por clientId + estado inicial ---
io.on("connection", (socket) => {
  socket.on("join", ({ clientId }) => {
    if (!clientId) return;
    socket.join(clientId);
    const c = getClient(clientId);
    if (c) {
      const code = c.__ready ? "ready" : c.__status || "connecting";
      socket.emit("status", {
        code,
        reason: c.__reason || "",
        ts: Date.now(),
      });
    }
  });
});

// --- Manejo de errores Express (fallback) ---
app.use((err, _req, res, _next) => {
  console.error("Express error:", err);
  res.status(500).json({ error: err?.message || "Server error" });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`🚀 Backend multi-sesión listo en http://localhost:${PORT}`);
});
