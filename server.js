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
} from "./sessions/sessionManager.js";

dotenv.config();

const app = express();

app.set('trust proxy', 1);

app.use(cors());
app.use(express.json());

// Seguridad simple por API key
const API_KEY = process.env.API_KEY || "change-me";
app.use((req, res, next) => {
  const key = req.header("x-api-key");
  if (!key || key !== API_KEY)
    return res.status(401).json({ error: "Unauthorized" });
  next();
});

// Rate limit básico (ajusta a tu tráfico)
app.use(
  rateLimit({
    windowMs: 60_000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });

// Mongo
connectMongo()
  .then(() => console.log("✅ MongoDB conectado"))
  .catch((e) => console.error("❌ Error Mongo:", e.message));

// Crear/reusar sesión
app.post("/api/session", (req, res) => {
  const { clientId } = req.body;
  if (!clientId) return res.status(400).json({ error: "Falta clientId" });
  getOrCreateClient({ clientId, io });
  res.json({ status: "pending", clientId });
});

// Enviar mensaje (texto o imagen) con reintento seguro
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

// Logout y borrado de auth (sólo manual)
app.post("/api/logout", (req, res) => {
  const { clientId } = req.body;
  if (!clientId) return res.status(400).json({ error: "Falta clientId" });
  logoutClient(clientId, io);
  res.json({ status: "logout", clientId });
});

// Listar sesiones
app.get("/api/sessions", (req, res) => {
  const list = Object.keys(clients).map((clientId) => {
    const c = clients[clientId];
    return { clientId, status: c.__status || "pending" };
  });
  res.json(list);
});

// Websockets
io.on("connection", (socket) => {
  socket.on("join", ({ clientId }) => {
    if (!clientId) return;
    socket.join(clientId);
    const c = getClient(clientId);
    if (c && c.__ready) socket.emit("status", { status: "ready" });
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`🚀 Backend multi-sesión listo en http://localhost:${PORT}`);
});
