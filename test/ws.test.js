import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import test from "node:test";
import { connectWebSocket } from "../src/ws.js";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function readClientFrame(buffer) {
  if (buffer.length < 2) return null;
  const second = buffer[1];
  const masked = (second & 0x80) !== 0;
  let length = second & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  const maskLength = masked ? 4 : 0;
  if (buffer.length < offset + maskLength + length) return null;
  let payload = buffer.subarray(offset + maskLength, offset + maskLength + length);
  if (masked) {
    const mask = buffer.subarray(offset, offset + 4);
    payload = Buffer.from(payload);
    for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
  }
  return {
    payload,
    rest: buffer.subarray(offset + maskLength + length),
  };
}

function encodeServerFrame(payload) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x81;
  return Buffer.concat([header, payload]);
}

function startEcho() {
  const server = http.createServer();
  server.on("upgrade", (req, socket) => {
    const accept = crypto.createHash("sha1").update(req.headers["sec-websocket-key"] + GUID).digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        const frame = readClientFrame(buffer);
        if (!frame) return;
        buffer = frame.rest;
        socket.write(encodeServerFrame(frame.payload));
      }
    });
    socket.on("end", () => socket.destroy());
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port });
    });
  });
}

test("WebSocketは大きなテキストを往復できる", async () => {
  const echo = await startEcho();
  try {
    const socket = await connectWebSocket(`ws://127.0.0.1:${echo.port}/devtools/browser/test`);
    const payload = "あ".repeat(80000);
    const received = new Promise((resolve) => {
      socket.onMessage((text) => resolve(text));
    });
    socket.send(payload);
    assert.equal(await received, payload);
    socket.close();
  } finally {
    echo.server.closeAllConnections();
    await new Promise((resolve) => echo.server.close(resolve));
  }
});
