const signingSecret = encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
console.log(`SESSION_SIGNING_SECRET=${signingSecret}`);

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
