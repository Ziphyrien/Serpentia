export type BoundedJsonErrorCode = "EMPTY_BODY" | "BODY_TOO_LARGE" | "INVALID_JSON";

export class BoundedJsonError extends Error {
  readonly _tag = "BoundedJsonError";

  constructor(readonly code: BoundedJsonErrorCode) {
    super(code);
  }
}

export async function readBoundedJson(request: Request, maximumBytes: number): Promise<unknown> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (Number.isFinite(length) && length > maximumBytes) {
      throw new BoundedJsonError("BODY_TOO_LARGE");
    }
  }

  if (request.body === null) throw new BoundedJsonError("EMPTY_BODY");
  const reader = request.body.getReader();
  const chunks: Array<Uint8Array> = [];
  let totalBytes = 0;

  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      totalBytes += result.value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel();
        throw new BoundedJsonError("BODY_TOO_LARGE");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }

  if (totalBytes === 0) throw new BoundedJsonError("EMPTY_BODY");
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new BoundedJsonError("INVALID_JSON");
  }
}
