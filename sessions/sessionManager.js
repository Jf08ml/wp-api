// sessions/sessionManager.js
import pkg from "whatsapp-web.js";
const { Client, LocalAuth, MessageMedia } = pkg;
import fs from "fs";
import path from "path";

// Fuerza Puppeteer completo (más estable en VPS)
import puppeteer from "puppeteer";

// Paths persistentes (no /tmp)
const AUTH_ROOT = process.env.AUTH_ROOT || "/opt/whatsapp/wwebjs_auth";
fs.mkdirSync(AUTH_ROOT, { recursive: true });

// Mapa global de clientes activos
export const clients = {}; // clientId -> Client (extendido con metadatos propios)

const SESSION_CLEANUP = {}; // clientId -> { keepAliveInterval, bootingPromise }
const CLOSED_RE =
  /Session closed|Target closed|Protocol error|WebSocket is not open/i;

// Cola mínima FIFO por clientId
class SimpleQueue {
  constructor() {
    this.q = [];
    this.running = false;
  }
  add(fn) {
    return new Promise((resolve, reject) => {
      this.q.push({ fn, resolve, reject });
      this._run();
    });
  }
  async _run() {
    if (this.running) return;
    this.running = true;
    while (this.q.length) {
      const { fn, resolve, reject } = this.q.shift();
      try {
        const out = await fn();
        resolve(out);
      } catch (e) {
        reject(e);
      }
    }
    this.running = false;
  }
}

function getQueue(clientId) {
  const c = clients[clientId];
  if (!c.__queue) c.__queue = new SimpleQueue();
  return c.__queue;
}

function isClosedError(e) {
  const msg = (e && e.message) || String(e || "");
  return CLOSED_RE.test(msg);
}

function buildClient(clientId, io) {
  const client = new Client({
    // auth persistente por clientId (wwebjs maneja subcarpetas dentro de dataPath)
    authStrategy: new LocalAuth({ clientId, dataPath: AUTH_ROOT }),
    puppeteer: {
      headless: true,
      // puppeteer completo: sin executablePath -> usa Chromium que trae puppeteer
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    },
  });

  // Metadatos útiles
  client.__ready = false;
  client.__status = "inicializando";
  client.__queue = new SimpleQueue();

  // Eventos
  client.on("qr", (qr) => {
    client.__status = "esperando_qr";
    io.to(clientId).emit("qr", { qr });
    console.log(`[${clientId}] Nuevo QR`);
  });

  client.on("authenticated", () => {
    client.__status = "authenticated";
    io.to(clientId).emit("status", { status: "authenticated" });
    console.log(`[${clientId}] Autenticado`);
  });

  client.on("ready", () => {
    client.__ready = true;
    client.__status = "ready";
    io.to(clientId).emit("status", { status: "ready" });
    console.log(`[${clientId}] Sesión lista`);
  });

  client.on("disconnected", (reason) => {
    client.__ready = false;
    client.__status = "disconnected";
    io.to(clientId).emit("status", { status: "disconnected", reason });
    console.log(`[${clientId}] Desconectado: ${reason}`);
    // ¡No borrar auth! Intentar reconectar pasivamente:
    setTimeout(() => ensureReady(clientId).catch(() => {}), 1500);
  });

  client.on("auth_failure", (msg) => {
    client.__ready = false;
    client.__status = "auth_failure";
    io.to(clientId).emit("status", { status: "auth_failure", error: msg });
    console.log(`[${clientId}] Fallo de autenticación`);
    // Aquí sí conviene limpiar, porque la credencial quedó inválida:
    // (opcional) limpiarSesion(clientId, io, "auth_failure");
  });

  // Keep-alive (cada 5 min)
  clearInterval(SESSION_CLEANUP[clientId]?.keepAliveInterval);
  SESSION_CLEANUP[clientId] = SESSION_CLEANUP[clientId] || {};
  SESSION_CLEANUP[clientId].keepAliveInterval = setInterval(() => {
    client
      .getState()
      .then((s) => {
        if (s !== "CONNECTED") {
          client.__ready = false;
          client.__status = "disconnected";
        }
      })
      .catch(() => {
        client.__ready = false;
        client.__status = "disconnected";
      });
  }, 60_000 * 5);

  return client;
}

export function getOrCreateClient({ clientId, io }) {
  if (clients[clientId]) return clients[clientId];
  const client = buildClient(clientId, io);
  clients[clientId] = client;
  client.initialize();
  return client;
}

export function getClient(clientId) {
  return clients[clientId] || null;
}

async function ensureReady(clientId) {
  const c = clients[clientId];
  if (!c) throw new Error("Sesión no existe");
  if (c.__ready) return;

  const slot = (SESSION_CLEANUP[clientId] = SESSION_CLEANUP[clientId] || {});
  if (!slot.bootingPromise) {
    c.__status =
      c.__status === "inicializando" ? "inicializando" : "reconectando";
    slot.bootingPromise = (async () => {
      try {
        await c.getState().catch(async () => {
          // Re-initialize; si ya estaba inicializando, wwebjs ignora
          try {
            await c.initialize();
          } catch {}
        });
      } finally {
        slot.bootingPromise = null;
      }
    })();
  }
  await slot.bootingPromise;
}

// Envío seguro con cola y reintento
export async function sendMessageSafe(clientId, { phone, message, image }) {
  const client = getClient(clientId);
  if (!client) throw new Error("Sesión no encontrada");

  // Normaliza phone
  const phoneStr = String(phone).replace(/\s/g, "");
  const chatId = phoneStr.endsWith("@c.us") ? phoneStr : `${phoneStr}@c.us`;

  const queue = getQueue(clientId);

  const run = async () => {
    await ensureReady(clientId);

    try {
      if (image) {
        let media;
        if (typeof image === "string" && image.startsWith("http")) {
          media = await MessageMedia.fromUrl(image);
        } else if (typeof image === "string" && image.startsWith("data:")) {
          const m = image.match(/^data:(.+);base64,(.+)$/);
          if (!m) throw new Error("Imagen base64 inválida");
          media = new MessageMedia(m[1], m[2]);
        } else if (typeof image === "string") {
          // base64 simple; asumimos PNG
          media = new MessageMedia("image/png", image);
        } else {
          throw new Error("Formato de imagen no soportado");
        }
        const r = await client.sendMessage(chatId, media, {
          caption: message || undefined,
        });
        return { id: r.id._serialized, attempt: 1 };
      } else {
        const r = await client.sendMessage(chatId, message);
        return { id: r.id._serialized, attempt: 1 };
      }
    } catch (e) {
      if (!isClosedError(e)) throw e;

      // Reintento 1: re-init y volver a enviar
      client.__ready = false;
      await ensureReady(clientId);

      if (image) {
        // Recontruye media (por si la instancia anterior lo invalidó)
        let media;
        if (typeof image === "string" && image.startsWith("http")) {
          media = await MessageMedia.fromUrl(image);
        } else if (typeof image === "string" && image.startsWith("data:")) {
          const m = image.match(/^data:(.+);base64,(.+)$/);
          if (!m) throw new Error("Imagen base64 inválida");
          media = new MessageMedia(m[1], m[2]);
        } else if (typeof image === "string") {
          media = new MessageMedia("image/png", image);
        } else {
          throw new Error("Formato de imagen no soportado");
        }
        const r2 = await client.sendMessage(chatId, media, {
          caption: message || undefined,
        });
        return { id: r2.id._serialized, attempt: 2 };
      } else {
        const r2 = await client.sendMessage(chatId, message);
        return { id: r2.id._serialized, attempt: 2 };
      }
    }
  };

  // Serializa por sesión
  return queue.add(run);
}

// Limpieza suave (logout manual) — aquí sí borramos carpeta
export function logoutClient(clientId, io) {
  const c = clients[clientId];
  if (c) {
    try {
      c.logout().catch(() => {});
    } catch {}
    try {
      c.destroy().catch(() => {});
    } catch {}
    delete clients[clientId];
  }
  // limpiar timers
  if (SESSION_CLEANUP[clientId]?.keepAliveInterval) {
    clearInterval(SESSION_CLEANUP[clientId].keepAliveInterval);
  }
  delete SESSION_CLEANUP[clientId];

  const authDir = path.join(AUTH_ROOT, "Session-" + clientId); // wwebjs crea subcarpetas internas
  // Borra todas las carpetas asociadas a ese clientId dentro de AUTH_ROOT
  try {
    fs.readdirSync(AUTH_ROOT)
      .filter((n) => n.includes(clientId))
      .forEach((n) =>
        fs.rmSync(path.join(AUTH_ROOT, n), { recursive: true, force: true })
      );
  } catch {}

  io.to(clientId).emit("session_cleaned", {
    status: "cleaned",
    motivo: "logout_manual",
  });
}

export { MessageMedia };
