import { Buffer } from "node:buffer";

interface EncodedBytes {
  readonly _lxType: "bytes";
  readonly data: string;
}

export function encodeRuntimeValue(value: unknown, depth = 0): unknown {
  if (depth > 16) return null;
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof ArrayBuffer) {
    return { _lxType: "bytes", data: Buffer.from(value).toString("base64") } satisfies EncodedBytes;
  }
  if (ArrayBuffer.isView(value)) {
    return {
      _lxType: "bytes",
      data: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64"),
    } satisfies EncodedBytes;
  }
  if (value instanceof Error) return { message: value.message };
  if (Array.isArray(value)) return value.map((item) => encodeRuntimeValue(item, depth + 1));
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, 128)) {
      output[key.slice(0, 128)] = encodeRuntimeValue(item, depth + 1);
    }
    return output;
  }
  return undefined;
}

export function decodeRuntimeValue(value: unknown, depth = 0): unknown {
  if (depth > 16 || value === null || typeof value !== "object") return value;
  if (isEncodedBytes(value)) return Buffer.from(value.data, "base64");
  if (Array.isArray(value)) return value.map((item) => decodeRuntimeValue(item, depth + 1));
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = decodeRuntimeValue(item, depth + 1);
  }
  return output;
}

function isEncodedBytes(value: object): value is EncodedBytes {
  return (
    "_lxType" in value &&
    value._lxType === "bytes" &&
    "data" in value &&
    typeof value.data === "string"
  );
}
