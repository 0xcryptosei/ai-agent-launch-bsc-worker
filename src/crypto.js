import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

function keyFor(secret) {
  return scryptSync(secret, "held-agent-key", 32);
}

export function encryptKey(secret, privateKey) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFor(secret), iv);
  const enc = Buffer.concat([cipher.update(privateKey, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("hex");
}

export function decryptKey(secret, payload) {
  const buf = Buffer.from(payload, "hex");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", keyFor(secret), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

export function exportToken() {
  return randomBytes(24).toString("hex");
}
