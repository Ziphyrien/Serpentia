/** 读取受大小限制的 JSON 请求体；超限、空体或格式错误一律抛出 Error。 */
export async function readBoundedJson(request: Request, maximumBytes: number): Promise<unknown> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (Number.isFinite(length) && length > maximumBytes) {
      throw new Error("Request body is too large");
    }
  }

  if (request.body === null) throw new Error("Request body is empty");
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
        throw new Error("Request body is too large");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }

  if (totalBytes === 0) throw new Error("Request body is empty");
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("Request body is not valid JSON");
  }
}
