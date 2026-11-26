const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });
const cookieName = "apnaai_session";
const enc = new TextEncoder();
const hex = bytes => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, "0")).join("");
const randomHex = (n = 32) => { const b = new Uint8Array(n); crypto.getRandomValues(b); return hex(b); };
async function digest(value) { return hex(await crypto.subtle.digest("SHA-256", enc.encode(value))); }
async function passwordHash(password, salt) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", salt: enc.encode(salt), iterations: 310000, hash: "SHA-256" }, key, 256));
}
function getCookie(request, name) {
  const raw = request.headers.get("Cookie") || "";
  const item = raw.split(";").map(x => x.trim()).find(x => x.startsWith(name + "="));
  return item ? decodeURIComponent(item.slice(name.length + 1)) : "";
}
function sessionCookie(token, maxAge) {
  return `${cookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}
async function currentUser(request, db) {
  const token = getCookie(request, cookieName);
  if (!token) return null;
  const row = await db.prepare("SELECT users.id, users.email, users.name FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.token_hash=? AND sessions.expires_at>?").bind(await digest(token), Date.now()).first();
  return row || null;
}
export async function onRequest({ request, env }) {
  if (!env.AUTH_DB) return json({ error: "Account service is not configured." }, 503);
  if (request.method !== "POST" && request.method !== "GET") return json({ error: "Method not allowed." }, 405, { Allow: "GET, POST" });
  const action = new URL(request.url).pathname.split("/").filter(Boolean).pop() || "";
  if (request.method === "GET" && action === "me") {
    const user = await currentUser(request, env.AUTH_DB);
    return json({ user });
  }
  if (request.method === "POST" && action === "logout") {
    const token = getCookie(request, cookieName);
    if (token) await env.AUTH_DB.prepare("DELETE FROM sessions WHERE token_hash=?").bind(await digest(token)).run();
    return json({ ok: true }, 200, { "Set-Cookie": sessionCookie("", 0) });
  }
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid request." }, 400); }
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 150) return json({ error: "Valid email address enter karein." }, 400);
  if (password.length < 10 || password.length > 128) return json({ error: "Password 10 se 128 characters ka hona chahiye." }, 400);
  if (action === "register") {
    const name = String(body.name || "").trim().replace(/[<>]/g, "").slice(0, 80);
    if (name.length < 2) return json({ error: "Apna naam enter karein." }, 400);
    const existing = await env.AUTH_DB.prepare("SELECT id FROM users WHERE email=?").bind(email).first();
    if (existing) return json({ error: "Is email ka account pehle se mojood hai. Login karein." }, 409);
    const salt = randomHex(16);
    const hash = await passwordHash(password, salt);
    const id = crypto.randomUUID();
    try {
      await env.AUTH_DB.prepare("INSERT INTO users (id,email,name,password_hash,password_salt,created_at) VALUES (?,?,?,?,?,?)").bind(id, email, name, hash, salt, Date.now()).run();
    } catch { return json({ error: "Account create nahi hua. Dobara try karein." }, 500); }
  } else if (action !== "login") {
    return json({ error: "Unknown action." }, 404);
  }
  const user = await env.AUTH_DB.prepare("SELECT id,email,name,password_hash,password_salt FROM users WHERE email=?").bind(email).first();
  if (!user) return json({ error: "Email ya password ghalat hai." }, 401);
  const attempt = await passwordHash(password, user.password_salt);
  if (attempt !== user.password_hash) return json({ error: "Email ya password ghalat hai." }, 401);
  const token = randomHex(32);
  const expires = Date.now() + 30 * 24 * 60 * 60 * 1000;
  await env.AUTH_DB.prepare("INSERT INTO sessions (token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)").bind(await digest(token), user.id, expires, Date.now()).run();
  return json({ ok: true, user: { id: user.id, name: user.name, email: user.email } }, 200, { "Set-Cookie": sessionCookie(token, 30 * 24 * 60 * 60) });
}
