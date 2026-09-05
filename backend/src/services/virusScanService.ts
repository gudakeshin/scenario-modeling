import { createConnection } from "node:net";
import { config } from "../config.js";

export interface VirusScanResult {
  status: "clean" | "infected" | "skipped";
  signature?: string;
  reason?: string;
}

/** Scan bytes using clamd's INSTREAM protocol. */
export async function scanBuffer(buffer: Buffer): Promise<VirusScanResult> {
  if (!config.CLAMAV_HOST) {
    if (config.CLAMAV_REQUIRED) {
      throw new Error("ClamAV is required but CLAMAV_HOST is not configured");
    }
    return { status: "skipped", reason: "ClamAV not configured" };
  }

  return new Promise<VirusScanResult>((resolve, reject) => {
    const socket = createConnection({
      host: config.CLAMAV_HOST,
      port: config.CLAMAV_PORT,
    });
    const response: Buffer[] = [];
    let settled = false;
    const finish = (result: VirusScanResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (config.CLAMAV_REQUIRED) reject(error);
      else resolve({ status: "skipped", reason: error.message });
    };

    socket.setTimeout(30_000, () => fail(new Error("ClamAV scan timed out")));
    socket.on("error", (error) => fail(error));
    socket.on("data", (chunk) => response.push(Buffer.from(chunk)));
    socket.on("end", () => {
      const text = Buffer.concat(response).toString("utf8").replace(/\0/g, "").trim();
      if (/\bOK$/.test(text)) {
        finish({ status: "clean" });
        return;
      }
      const infected = text.match(/stream:\s*(.+)\s+FOUND$/i);
      if (infected) {
        finish({ status: "infected", signature: infected[1].trim() });
        return;
      }
      fail(new Error(`Unexpected ClamAV response: ${text || "(empty)"}`));
    });
    socket.on("connect", () => {
      socket.write("zINSTREAM\0");
      const chunkSize = 64 * 1024;
      for (let offset = 0; offset < buffer.length; offset += chunkSize) {
        const chunk = buffer.subarray(offset, Math.min(offset + chunkSize, buffer.length));
        const length = Buffer.allocUnsafe(4);
        length.writeUInt32BE(chunk.length, 0);
        socket.write(length);
        socket.write(chunk);
      }
      socket.write(Buffer.alloc(4));
    });
  });
}
