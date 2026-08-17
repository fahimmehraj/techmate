const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function key() {
  const raw = process.env.TOKEN_ENCRYPTION_KEY_BASE64;
  if (!raw) throw new Error("TOKEN_ENCRYPTION_KEY_BASE64 is required.");
  const bytes = Uint8Array.from(atob(raw), (char) => char.charCodeAt(0));
  if (bytes.byteLength !== 32) throw new Error("TOKEN_ENCRYPTION_KEY_BASE64 must contain exactly 32 bytes.");
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(value: string): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, await key(), encoder.encode(value)));
  const output = new Uint8Array(nonce.length + encrypted.length);
  output.set(nonce);
  output.set(encrypted, nonce.length);
  return btoa(String.fromCharCode(...output));
}

export async function decryptSecret(value: string): Promise<string> {
  const data = Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: data.slice(0, 12) }, await key(), data.slice(12));
  return decoder.decode(plaintext);
}
