import { encryptSecret } from "../crypto.ts";

const googleAuthUrl = "https://accounts.google.com/o/oauth2/v2/auth";
const googleTokenUrl = "https://oauth2.googleapis.com/token";

export type OAuthStart = { state: string; codeVerifier: string; kind: "organizer" | "availability" };

export const googleScopesFor = (kind: OAuthStart["kind"]) => [
  "openid",
  "email",
  kind === "organizer"
    ? "https://www.googleapis.com/auth/calendar.events.owned"
    : "https://www.googleapis.com/auth/calendar.events.freebusy",
];

export async function createGoogleAuthorizationUrl(input: OAuthStart) {
  const baseUrl = required("APP_BASE_URL");
  const scopes = googleScopesFor(input.kind);
  const challenge = await sha256Base64Url(input.codeVerifier);
  const url = new URL(googleAuthUrl);
  url.search = new URLSearchParams({
    client_id: required("GOOGLE_CLIENT_ID"),
    redirect_uri: `${baseUrl}/oauth/google/callback`,
    response_type: "code",
    scope: scopes.join(" "),
    access_type: "offline",
    prompt: "consent",
    state: input.state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

export async function exchangeGoogleCode(code: string, codeVerifier: string) {
  const body = new URLSearchParams({
    code,
    client_id: required("GOOGLE_CLIENT_ID"),
    client_secret: required("GOOGLE_CLIENT_SECRET"),
    redirect_uri: `${required("APP_BASE_URL")}/oauth/google/callback`,
    grant_type: "authorization_code",
    code_verifier: codeVerifier,
  });
  const response = await fetch(googleTokenUrl, { method: "POST", body });
  if (!response.ok) throw new Error(`Google token exchange failed: ${await response.text()}`);
  const payload = await response.json() as { refresh_token?: string; access_token: string };
  if (!payload.refresh_token) throw new Error("Google did not return a refresh token. Revoke existing consent and try again.");
  const profile = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", { headers: { Authorization: `Bearer ${payload.access_token}` } });
  if (!profile.ok) throw new Error("Unable to read the connected Google account.");
  const user = await profile.json() as { email?: string };
  if (!user.email) throw new Error("Google did not return an email address.");
  return { email: user.email, encryptedRefreshToken: await encryptSecret(payload.refresh_token) };
}

export const createState = () => crypto.randomUUID();
export const createCodeVerifier = () => crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");

async function sha256Base64Url(value: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return btoa(String.fromCharCode(...digest)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
