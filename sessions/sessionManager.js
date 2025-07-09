// sessions/sessionManager.js

import pkg from "whatsapp-web.js";
const { Client, LocalAuth, MessageMedia } = pkg;
import fs from "fs";
import path from "path";

// Mapa global de clientes activos
export const clients = {}; // <-- EXPORTA AQUÍ

export function getOrCreateClient({ clientId, io }) {
  if (clients[clientId]) return clients[clientId];

  // Carpeta separada por cliente
  const authPath = path.join("wwebjs_auth", clientId);
  if (!fs.existsSync("wwebjs_auth")) fs.mkdirSync("wwebjs_auth");
  if (!fs.existsSync(authPath)) fs.mkdirSync(authPath);

  const client = new Client({
    authStrategy: new LocalAuth({ clientId, dataPath: "wwebjs_auth" }),
    puppeteer: {
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
      // Puedes especificar executablePath si es necesario
    },
  });

  clients[clientId] = client;

  // Eventos principales
  client.on("qr", (qr) => {
    io.to(clientId).emit("qr", { qr });
    console.log(`[${clientId}] Nuevo QR emitido`);
  });

  client.on("ready", () => {
    io.to(clientId).emit("status", { status: "ready" });
    client.status = "ready"; // <-- Puedes guardar el estado aquí
    console.log(`[${clientId}] Sesión lista`);
  });

  client.on("authenticated", () => {
    io.to(clientId).emit("status", { status: "authenticated" });
    client.status = "authenticated";
    console.log(`[${clientId}] Autenticado`);
  });

  client.on("auth_failure", (msg) => {
    io.to(clientId).emit("status", { status: "auth_failure", error: msg });
    client.status = "auth_failure";
    console.log(`[${clientId}] Fallo de autenticación`);
    limpiarSesion(clientId, io, "auth_failure");
  });

  client.on("disconnected", (reason) => {
    io.to(clientId).emit("status", { status: "disconnected", reason });
    client.status = "disconnected";
    console.log(`[${clientId}] Desconectado`);
    limpiarSesion(clientId, io, "disconnected");
  });

  client.initialize();

  return client;
}

export function getClient(clientId) {
  return clients[clientId] || null;
}

// FUNCION CENTRAL de limpieza para usar en ambos lugares
function limpiarSesion(clientId, io, motivo = "") {
  if (clients[clientId]) {
    try {
      clients[clientId].destroy();
    } catch (err) {
      console.error(`[${clientId}] Error destruyendo cliente:`, err);
    }
    delete clients[clientId];
  }

  // Elimina carpeta de auth de la sesión
  const authDir = path.join("wwebjs_auth", clientId);
  if (fs.existsSync(authDir)) {
    fs.rmSync(authDir, { recursive: true, force: true });
    console.log(`[${clientId}] Archivos de sesión eliminados`);
  }

  // Opcional: notificar por websocket si necesitas más feedback
  io.to(clientId).emit("session_cleaned", { status: "cleaned", motivo });
}

// Función pública para logout manual (desde endpoint)
export function logoutClient(clientId, io) {
  limpiarSesion(clientId, io, "logout_manual");
}

// Exporta MessageMedia para uso en otros archivos
export { MessageMedia };
