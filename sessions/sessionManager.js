// sessions/sessionManager.js
import pkg from "whatsapp-web.js";
const { Client, LocalAuth, MessageMedia } = pkg;
import fs from "fs";
import path from "path";

// Fuerza Puppeteer completo (más estable en VPS)
import puppeteer from "puppeteer"; // eslint-disable-line no-unused-vars

// ===== Config / Estado global =====
const AUTH_ROOT = process.env.AUTH_ROOT || "/opt/whatsapp/wwebjs_auth";
fs.mkdirSync(AUTH_ROOT, { recursive: true });

export const clients = {};          // clientId -> Client (extendido)
const SESSION = {};                 // clientId -> { keepAliveInterval, bootingPromise }
const CLOSED_RE = /Session closed|Target closed|Protocol error|WebSocket is not open/i;

// ===== Utilidades =====
class SimpleQueue {
  constructor() { this.q = []; this.running = false; }
  add(fn) {
    return new Promise((resolve, reject) => { this.q.push({ fn, resolve, reject }); this._run(); });
  }
  async _run() {
    if (this.running) return;
    this.running = true;
    while (this.q.length) {
      const { fn, resolve, reject } = this.q.shift();
      try { resolve(await fn()); } catch (e) { reject(e); }
    }
    this.running = false;
  }
}

const getQueue = (clientId) => {
  const c = clients[clientId];
  if (!c.__queue) c.__queue = new SimpleQueue();
  return c.__queue;
};

const isClosedError = (e) => CLOSED_RE.test(((e && e.message) || String(e || "")));

const now = () => Date.now();

const mapWWebStateToReason = (st) => {
  switch (st) {
    case "CONFLICT": return "conflict";
    case "UNPAIRED": return "phone_unpaired";
    case "OPENING":  return "opening";
    default:         return (st || "unknown").toLowerCase();
  }
};

// ===== Emisión de estados normalizados =====
// code: 'connecting' | 'waiting_qr' | 'authenticated' | 'ready' | 'disconnected' | 'auth_failure' | 'reconnecting' | 'error'
function emitStatus(io, clientId, code, reason = "") {
  const c = clients[clientId];
  if (c) {
    c.__status = code;
    c.__reason = reason || "";
    if (code === "ready") c.__lastReadyAt = now();
    if (code === "waiting_qr") c.__lastQrAt = now();
  }
  io.to(clientId).emit("status", { code, reason, ts: now() });
}

// ===== Creación de cliente por sesión =====
function buildClient(clientId, io) {
  const client = new Client({
    authStrategy: new LocalAuth({ clientId, dataPath: AUTH_ROOT }),
    puppeteer: {
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    },
  });

  // Metadatos útiles
  client.__ready = false;
  client.__status = "connecting";
  client.__reason = "";
  client.__queue = new SimpleQueue();
  client.__lastQrAt = 0;
  client.__lastReadyAt = 0;

  // Eventos WhatsApp Web.js
  client.on("qr", (qr) => {
    emitStatus(io, clientId, "waiting_qr");
    io.to(clientId).emit("qr", { qr });
    console.log(`[${clientId}] QR generado`);
  });

  client.on("authenticated", () => {
    emitStatus(io, clientId, "authenticated");
    console.log(`[${clientId}] Autenticado`);
  });

  client.on("ready", () => {
    client.__ready = true;
    emitStatus(io, clientId, "ready");
    console.log(`[${clientId}] Sesión lista`);
  });

  client.on("disconnected", async (reason) => {
    client.__ready = false;
    emitStatus(io, clientId, "disconnected", (reason || "unknown").toString());
    console.log(`[${clientId}] Desconectado: ${reason}`);
    // Reintento pasivo sin borrar credenciales
    setTimeout(() => ensureReady(clientId).catch(() => {}), 1500);
  });

  client.on("auth_failure", (msg) => {
    client.__ready = false;
    emitStatus(io, clientId, "auth_failure", "bad_credentials");
    console.log(`[${clientId}] Fallo de autenticación: ${msg}`);
    // No borramos aquí; el frontend decidirá si limpiar y re-vincular.
  });

  // Estado interno de wwebjs (útil para conflicto, etc.)
  client.on("change_state", (st) => {
    const reason = mapWWebStateToReason(st);
    if (!client.__ready) emitStatus(io, clientId, "reconnecting", reason);
  });

  // Keep-alive (cada 5 min)
  clearInterval(SESSION[clientId]?.keepAliveInterval);
  SESSION[clientId] = SESSION[clientId] || {};
  SESSION[clientId].keepAliveInterval = setInterval(() => {
    client.getState()
      .then((s) => {
        if (s !== "CONNECTED") {
          client.__ready = false;
          emitStatus(io, clientId, "disconnected", mapWWebStateToReason(s));
        }
      })
      .catch(() => {
        client.__ready = false;
        emitStatus(io, clientId, "disconnected", "unknown");
      });
  }, 60_000 * 5);

  return client;
}

// ===== API de sesión =====
export function getOrCreateClient({ clientId, io }) {
  if (clients[clientId]) return clients[clientId];
  const c = buildClient(clientId, io);
  clients[clientId] = c;
  emitStatus(io, clientId, "connecting");
  c.initialize().catch((e) => {
    emitStatus(io, clientId, "error", e.message || "init_failed");
  });
  return c;
}

export function getClient(clientId) {
  return clients[clientId] || null;
}

async function ensureReady(clientId) {
  const c = clients[clientId];
  if (!c) throw new Error("Sesión no existe");
  if (c.__ready) return;

  const slot = (SESSION[clientId] = SESSION[clientId] || {});
  if (!slot.bootingPromise) {
    emitStatus(c.__io || { to: () => ({ emit: () => {} }) }, clientId, "reconnecting", "booting");
    slot.bootingPromise = (async () => {
      try {
        await c.getState().catch(async () => {
          try { await c.initialize(); } catch {}
        });
      } finally { slot.bootingPromise = null; }
    })();
  }
  await slot.bootingPromise;
}

// Reiniciar sesión sin perder login (mantiene LocalAuth)
export async function restartClient(clientId, io) {
  const c = clients[clientId];
  if (!c) throw new Error("Sesión no encontrada");

  try { await c.destroy(); } catch {}
  delete clients[clientId];

  const fresh = buildClient(clientId, io);
  clients[clientId] = fresh;
  emitStatus(io, clientId, "reconnecting", "manual_restart");
  await fresh.initialize().catch((e) => {
    emitStatus(io, clientId, "error", e.message || "reinit_failed");
  });
  return fresh;
}

// ===== Envío seguro (cola + reintento) =====
export async function sendMessageSafe(clientId, { phone, message, image }) {
  const client = getClient(clientId);
  if (!client) throw new Error("Sesión no encontrada");

  const phoneStr = String(phone).replace(/\s/g, "");
  const chatId = phoneStr.endsWith("@c.us") ? phoneStr : `${phoneStr}@c.us`;
  const queue = getQueue(clientId);

  const run = async () => {
    await ensureReady(clientId);

    const sendOnce = async () => {
      if (image) {
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
        return client.sendMessage(chatId, media, { caption: message || undefined });
      } else {
        return client.sendMessage(chatId, message);
      }
    };

    try {
      const r = await sendOnce();
      return { id: r.id._serialized, attempt: 1 };
    } catch (e) {
      if (!isClosedError(e)) throw e;
      // Reintento: re-init + reenvío
      client.__ready = false;
      await ensureReady(clientId);
      const r2 = await sendOnce();
      return { id: r2.id._serialized, attempt: 2 };
    }
  };

  return queue.add(run);
}

// ===== Logout manual (aquí sí borramos credenciales) =====
export function logoutClient(clientId, io) {
  const c = clients[clientId];
  if (c) {
    try { c.logout().catch(() => {}); } catch {}
    try { c.destroy().catch(() => {}); } catch {}
    delete clients[clientId];
  }
  // limpiar timers
  if (SESSION[clientId]?.keepAliveInterval) {
    clearInterval(SESSION[clientId].keepAliveInterval);
  }
  delete SESSION[clientId];

  // Borrar data de autenticación (exige re-escanear QR)
  try {
    fs.readdirSync(AUTH_ROOT)
      .filter((n) => n.includes(clientId))
      .forEach((n) => fs.rmSync(path.join(AUTH_ROOT, n), { recursive: true, force: true }));
  } catch {}

  io.to(clientId).emit("session_cleaned", { status: "cleaned", motivo: "logout_manual" });
}

export { MessageMedia };
