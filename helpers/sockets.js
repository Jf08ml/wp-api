// helpers/sockets.js
export function emitStatus(io, clientId, code, reason = "") {
  // code: 'connecting' | 'waiting_qr' | 'authenticated' | 'ready' | 'disconnected' | 'auth_failure' | 'reconnecting' | 'error'
  io.to(clientId).emit("status", { code, reason, ts: Date.now() });
}
