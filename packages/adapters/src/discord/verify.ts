const hexToBytes = (hex: string) => Uint8Array.from(hex.match(/.{1,2}/g) ?? [], (value) => Number.parseInt(value, 16));

export async function verifyDiscordRequest(request: Request, body: string): Promise<boolean> {
  const signature = request.headers.get("x-signature-ed25519")?.trim();
  const timestamp = request.headers.get("x-signature-timestamp")?.trim();
  const publicKey = process.env.DISCORD_PUBLIC_KEY?.trim();
  if (!signature || !timestamp || !publicKey) return false;
  if (!/^[0-9a-f]{64}$/i.test(publicKey) || !/^[0-9a-f]{128}$/i.test(signature)) return false;
  try {
    const key = await crypto.subtle.importKey("raw", hexToBytes(publicKey), { name: "Ed25519" }, false, ["verify"]);
    return crypto.subtle.verify("Ed25519", key, hexToBytes(signature), new TextEncoder().encode(timestamp + body));
  } catch {
    return false;
  }
}
