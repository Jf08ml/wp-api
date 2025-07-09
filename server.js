import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { createServer } from "http";
import { Server } from "socket.io";
import { connectMongo } from "./db/mongo.js";
import {
  clients,
  getOrCreateClient,
  getClient,
  logoutClient,
  MessageMedia, // 👈 IMPORTANTE
} from "./sessions/sessionManager.js";

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*" },
});

// Mongo
connectMongo()
  .then(() => console.log("✅ MongoDB conectado"))
  .catch(console.error);

// API: Crear sesión (o reutilizar si existe)
app.post("/api/session", (req, res) => {
  const { clientId } = req.body;
  if (!clientId) return res.status(400).json({ error: "Falta clientId" });
  getOrCreateClient({ clientId, io });
  res.json({ status: "pending", clientId });
});

// API: Enviar mensaje (texto y/o imagen)
app.post("/api/send", async (req, res) => {
  const { clientId, phone, message, image } = req.body;
  // phone y clientId deben existir, y debe haber mensaje o imagen
  if (!clientId || !phone || (!message && !image)) {
    return res
      .status(400)
      .json({ error: "Faltan datos: mínimo mensaje o imagen" });
  }
  const client = getClient(clientId);
  if (!client) return res.status(404).json({ error: "Sesión no encontrada" });

  try {
    // Siempre convierte phone a string y quita espacios
    const phoneStr = String(phone).replace(/\s/g, "");
    const chatId = phoneStr.endsWith("@c.us") ? phoneStr : `${phoneStr}@c.us`;

    if (image) {
      let media;
      if (image.startsWith("http")) {
        // URL de imagen
        media = await MessageMedia.fromUrl(image);
      } else if (image.startsWith("data:")) {
        // DataURL base64 (data:image/png;base64,....)
        const matches = image.match(/^data:(.+);base64,(.+)$/);
        if (!matches) throw new Error("Imagen base64 inválida");
        media = new MessageMedia(matches[1], matches[2]);
      } else {
        // Base64 simple, asume PNG
        media = new MessageMedia("image/png", image);
      }
      const sendResult = await client.sendMessage(chatId, media, {
        caption: message || undefined,
      });
      res.json({ status: "sent", id: sendResult.id._serialized });
    } else {
      // Solo texto
      const sendResult = await client.sendMessage(chatId, message);
      res.json({ status: "sent", id: sendResult.id._serialized });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Cerrar sesión y borrar auth
app.post("/api/logout", (req, res) => {
  const { clientId } = req.body;
  if (!clientId) return res.status(400).json({ error: "Falta clientId" });
  logoutClient(clientId, io);
  res.json({ status: "logout", clientId });
});

// API: Listar sesiones activas
app.get("/api/sessions", (req, res) => {
  const list = Object.keys(clients).map((clientId) => {
    const client = clients[clientId];
    let status = "pending";
    if (client.info && client.info.me) status = "ready";
    else if (client.info && client.info.pushname) status = "authenticated";
    return { clientId, status };
  });
  res.json(list);
});

// Websockets
io.on("connection", (socket) => {
  socket.on("join", ({ clientId }) => {
    if (!clientId) return;
    socket.join(clientId);
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
