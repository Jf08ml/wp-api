import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { createServer } from "http";
import { Server } from "socket.io";
import { connectMongo } from "./db/mongo.js";
import { getOrCreateClient, getClient, logoutClient } from "./sessions/sessionManager.js";

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*" }
});

// Mongo
connectMongo().then(() => console.log("✅ MongoDB conectado")).catch(console.error);

// API: Crear sesión (o reutilizar si existe)
app.post("/api/session", (req, res) => {
  const { clientId } = req.body;
  if (!clientId) return res.status(400).json({ error: "Falta clientId" });
  getOrCreateClient({ clientId, io });
  res.json({ status: "pending", clientId });
});

// API: Enviar mensaje
app.post("/api/send", async (req, res) => {
  const { clientId, phone, message } = req.body;
  if (!clientId || !phone || !message) {
    return res.status(400).json({ error: "Faltan datos" });
  }
  const client = getClient(clientId);
  if (!client) return res.status(404).json({ error: "Sesión no encontrada" });
  try {
    const chatId = phone.endsWith("@c.us") ? phone : `${phone}@c.us`;
    const sendResult = await client.sendMessage(chatId, message);
    res.json({ status: "sent", id: sendResult.id._serialized });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Cerrar sesión y borrar auth
app.post("/api/logout", (req, res) => {
  const { clientId } = req.body;
  if (!clientId) return res.status(400).json({ error: "Falta clientId" });
  logoutClient(clientId, io); // <--- PASA EL io AQUÍ
  res.json({ status: "logout", clientId });
});

// Websockets
io.on("connection", (socket) => {
  // El frontend debe emitir join con su clientId
  socket.on("join", ({ clientId }) => {
    if (!clientId) return;
    socket.join(clientId);
    // Opcional: enviar estado actual (si hay)
    const client = getClient(clientId);
    if (client && client.info && client.info.me) {
      socket.emit("status", { status: "ready" });
    }
  });

  socket.on("disconnect", () => {
    // Opcional: cleanup
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`🚀 Backend multi-sesión listo en http://localhost:${PORT}`);
});
