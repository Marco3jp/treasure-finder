import crypto from "node:crypto";
import net from "node:net";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_MESSAGE = 32 * 1024 * 1024;

function encodeClientFrame(payload, opcode) {
  const body = Buffer.isBuffer(payload) ? Buffer.from(payload) : Buffer.from(payload);
  const mask = crypto.randomBytes(4);
  const length = body.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(6);
    header[1] = 0x80 | length;
    mask.copy(header, 2);
  } else if (length < 65536) {
    header = Buffer.alloc(8);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
    mask.copy(header, 4);
  } else {
    header = Buffer.alloc(14);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
    mask.copy(header, 10);
  }
  header[0] = 0x80 | opcode;
  for (let index = 0; index < body.length; index += 1) body[index] ^= mask[index % 4];
  return Buffer.concat([header, body]);
}

function readFrame(buffer) {
  if (buffer.length < 2) return null;
  const first = buffer[0];
  const second = buffer[1];
  const fin = (first & 0x80) !== 0;
  const opcode = first & 0x0f;
  const masked = (second & 0x80) !== 0;
  let length = second & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    const declared = buffer.readBigUInt64BE(2);
    if (declared > BigInt(MAX_MESSAGE)) {
      throw new Error("WebSocketのメッセージが大きすぎます");
    }
    length = Number(declared);
    offset = 10;
  }
  if (length > MAX_MESSAGE) throw new Error("WebSocketのメッセージが大きすぎます");
  const maskLength = masked ? 4 : 0;
  if (buffer.length < offset + maskLength + length) return null;
  let payload = buffer.subarray(offset + maskLength, offset + maskLength + length);
  if (masked) {
    const mask = buffer.subarray(offset, offset + 4);
    payload = Buffer.from(payload);
    for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
  }
  return {
    fin,
    opcode,
    payload,
    rest: buffer.subarray(offset + maskLength + length),
  };
}

export function connectWebSocket(url, { timeout = 10000 } = {}) {
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const socket = net.connect({
      host: parsed.hostname,
      port: Number(parsed.port || 80),
    });
    socket.setTimeout(timeout);
    socket.setNoDelay(true);
    const key = crypto.randomBytes(16).toString("base64");
    let headerBuffer = Buffer.alloc(0);
    let frameBuffer = Buffer.alloc(0);
    let established = false;
    let failed = false;
    const queued = [];
    let onMessage = null;
    let onClose = null;
    let closed = false;

    function fail(error) {
      if (failed || established) return;
      failed = true;
      socket.destroy();
      reject(error);
    }

    function emitMessage(text) {
      if (onMessage) onMessage(text);
      else queued.push(text);
    }

    function emitClose() {
      if (closed) return;
      closed = true;
      if (onClose) onClose();
    }

    function consumeFrames() {
      while (frameBuffer.length) {
        const frame = readFrame(frameBuffer);
        if (!frame) return;
        frameBuffer = frame.rest;
        if (frame.opcode === 8) {
          socket.end();
          emitClose();
          return;
        }
        if (frame.opcode === 9) {
          socket.write(encodeClientFrame(frame.payload, 0xA));
          continue;
        }
        if (frame.opcode === 0xA) continue;
        if (frame.opcode === 1 || frame.opcode === 2) {
          pending = frame.fin ? [] : [frame.payload];
          if (!frame.fin) continue;
          emitMessage(frame.payload.toString("utf8"));
          continue;
        }
        if (frame.opcode === 0) {
          pending.push(frame.payload);
          if (frame.fin) {
            const text = Buffer.concat(pending).toString("utf8");
            pending = [];
            emitMessage(text);
          }
        }
      }
    }

    let pending = [];

    socket.on("timeout", () => {
      if (!established) fail(new Error("WebSocketの接続がタイムアウトしました"));
    });
    socket.on("error", (error) => {
      if (!established) fail(error);
      else emitClose();
    });
    socket.on("close", () => {
      if (!established) fail(new Error("WebSocketが切断されました"));
      else emitClose();
    });
    socket.on("data", (chunk) => {
      if (!established) {
        headerBuffer = Buffer.concat([headerBuffer, chunk]);
        const split = headerBuffer.indexOf("\r\n\r\n");
        if (split === -1) return;
        const header = headerBuffer.subarray(0, split).toString("utf8");
        const status = header.split("\r\n")[0] || "";
        if (!/\s101\s/.test(status)) {
          fail(new Error(`WebSocketの接続に失敗しました: ${status}`));
          return;
        }
        const accept = /sec-websocket-accept:\s*(\S+)/i.exec(header)?.[1];
        const expected = crypto.createHash("sha1").update(key + GUID).digest("base64");
        if (accept !== expected) {
          fail(new Error("WebSocketの応答が不正です"));
          return;
        }
        established = true;
        socket.setTimeout(0);
        frameBuffer = headerBuffer.subarray(split + 4);
        resolve(api);
        try {
          consumeFrames();
        } catch (error) {
          socket.destroy();
          emitClose();
        }
        return;
      }
      frameBuffer = Buffer.concat([frameBuffer, chunk]);
      try {
        consumeFrames();
      } catch (error) {
        socket.destroy();
        emitClose();
      }
    });
    socket.on("connect", () => {
      const path = `${parsed.pathname}${parsed.search}` || "/";
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: ${parsed.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });

    const api = {
      send(text) {
        if (closed) throw new Error("WebSocketは閉じています");
        socket.write(encodeClientFrame(text, 0x1));
      },
      onMessage(handler) {
        onMessage = handler;
        for (const text of queued.splice(0)) handler(text);
      },
      onClose(handler) {
        onClose = handler;
        if (closed) handler();
      },
      close() {
        if (closed) return;
        try {
          socket.write(encodeClientFrame(Buffer.alloc(0), 0x8));
        } catch {
          // 閉じる途中の書き込み失敗は切断として扱う
        }
        socket.end();
        emitClose();
      },
    };
  });
}
