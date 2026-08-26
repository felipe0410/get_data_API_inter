// Cliente HTTP puro para Interrapidísimo (sin Playwright).
// Replica: login cifrado (API JSON) + consulta ASP.NET WebForms (ViewState).
// Ver memoria del proyecto: inter-http-auth-flow.
import crypto from "crypto";

const KEY_ENCRYPT = "1nt3rR4p1d1c1m0D";
const API = "https://www3.interrapidisimo.com/apilogin";
const ASPX =
  "https://reportes.interrapidisimo.com:8081/Reportes/ExploradorEnvios/ExploradorEnvios.aspx";
const UA = "Mozilla/5.0";

// Índices de pestaña del TabContainer2 (descubiertos por reconocimiento)
export const TAB_ESTADO = 0; // TabPanel8 -> tbxGestionEnvio
export const TAB_GESTION_APP = 3; // TabPanel4 -> gvGestionApp

// ---------------------------------------------------------------------------
// Cifrado cliente (idéntico al bundle Angular del SitioLogin)
//   PBKDF2(keyEncrypt, saltRandom16, iter=100, len=32, sha1) -> AES-256-CBC/Pkcs7
//   payload = Base64( salt(16) ++ iv(16) ++ ciphertext )
// ---------------------------------------------------------------------------
function encrypt(plain) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(16);
  const key = crypto.pbkdf2Sync(KEY_ENCRYPT, salt, 100, 32, "sha1");
  const c = crypto.createCipheriv("aes-256-cbc", key, iv);
  const ct = Buffer.concat([c.update(Buffer.from(plain, "utf8")), c.final()]);
  return Buffer.concat([salt, iv, ct]).toString("base64");
}

async function apiLogin(body) {
  const res = await fetch(API + "/api/Autenticacion/Login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return json?.usuario?.Data?.Token || null;
}

// ---------------------------------------------------------------------------
// Caché del keyinter (JWT de la app, vive 30 min). Evita re-login por request.
//
// La clave incluye un hash de la contraseña, no solo el usuario: la contraseña
// llega en cada request y puede cambiar (rotación, o simplemente venir mal
// escrita). Con la clave solo por usuario, una request con la contraseña
// equivocada reutilizaba el token de un login anterior correcto y respondía
// como si nada. Se hashea para no dejar la contraseña en claro en memoria.
// ---------------------------------------------------------------------------
const tokenCache = new Map(); // claveCache -> { keyinter, exp(ms), inflight }

function claveCache(user, pass) {
  return user + ":" + crypto.createHash("sha256").update(pass).digest("hex");
}

export async function getKeyinter(user, pass) {
  const now = Date.now();
  const clave = claveCache(user, pass);
  const cached = tokenCache.get(clave);
  // Reutiliza si quedan >60s de vida
  if (cached?.keyinter && cached.exp - now > 60_000) return cached.keyinter;
  if (cached?.inflight) return cached.inflight;

  const inflight = (async () => {
    // Basta la llamada de aplicación: el keyinter (rol ExploradorEnvios) se
    // obtiene directo. La primera llamada del navegador (rol Usuario) no es
    // necesaria para consultar, y saltarla reduce el login a la mitad (~15s).
    const keyinter = await apiLogin({
      UserName: encrypt(user),
      Password: encrypt(pass), // = slSiteKey, se calcula localmente
      nombreAplicacion: "ExploradorEnvios",
      nombreRol: "ExploradorEnvios",
    });
    if (!keyinter)
      throw new Error(
        "Login falló: credenciales inválidas o API de autenticación caída"
      );
    let exp = now + 25 * 60_000; // fallback 25 min
    try {
      const p = JSON.parse(Buffer.from(keyinter.split(".")[1], "base64").toString());
      if (p.exp) exp = p.exp * 1000;
    } catch {}
    tokenCache.set(clave, { keyinter, exp });
    return keyinter;
  })();

  tokenCache.set(clave, { ...(cached || {}), inflight });
  try {
    return await inflight;
  } catch (e) {
    tokenCache.delete(clave); // no cachear fallos
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Cookie jar mínimo
// ---------------------------------------------------------------------------
class Jar {
  constructor() {
    this.c = new Map();
  }
  store(setCookie) {
    if (!setCookie) return;
    for (const line of Array.isArray(setCookie) ? setCookie : [setCookie]) {
      const [pair] = line.split(";");
      const i = pair.indexOf("=");
      if (i > 0) this.c.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }
  header() {
    return [...this.c].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}
function setCookieOf(res) {
  try {
    const a = res.headers.getSetCookie?.();
    if (a && a.length) return a;
  } catch {}
  const s = res.headers.get("set-cookie");
  return s ? [s] : [];
}

// ---------------------------------------------------------------------------
// Parsing WebForms
// ---------------------------------------------------------------------------
function decodeHtml(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}
function hiddens(html) {
  const out = {};
  const re = /<input[^>]*type="hidden"[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const name = (tag.match(/name="([^"]*)"/) || [])[1];
    const val = (tag.match(/value="([^"]*)"/) || [])[1] || "";
    if (name) out[name] = decodeHtml(val);
  }
  return out;
}
// Los datos del portal traen basura de control: se han visto bytes NUL en
// medio de nombres, direcciones y celulares. Playwright los ocultaba porque el
// navegador los convertía en U+FFFD al leer el DOM; por HTTP llegan crudos, y
// un \u0000 dentro de un placeholder de plantilla puede hacer que Infobip
// rechace el mensaje. Se limpian al extraer, no en `hiddens`: el __VIEWSTATE
// no se toca.
function limpiarControl(v) {
  return typeof v === "string" ? v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "") : v;
}

export function inputByName(html, name) {
  const safe = name.replace(/[$]/g, "\\$");
  const m = html.match(new RegExp(`<input[^>]*name="${safe}"[^>]*>`, "i"));
  if (!m) return null;
  const v = m[0].match(/value="([^"]*)"/);
  return v ? limpiarControl(decodeHtml(v[1])) : "";
}
export function inputById(html, id) {
  const safe = id.replace(/[$]/g, "\\$");
  const m = html.match(new RegExp(`<input[^>]*id="${safe}"[^>]*>`, "i"));
  if (!m) return null;
  const v = m[0].match(/value="([^"]*)"/);
  return v ? limpiarControl(decodeHtml(v[1])) : "";
}
// Filas de la tabla de gestiones (gvGestionApp), sin el header.
export function gestionRows(html) {
  const t = html.match(
    /<table[^>]*id="TabContainer2_TabPanel4_gvGestionApp"[\s\S]*?<\/table>/i
  );
  if (!t) return [];
  const rows = [...t[0].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const cells = [...rows[i][1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) =>
      limpiarControl(decodeHtml(c[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()))
    );
    if (cells.length >= 3)
      out.push({ fecha: cells[0], tipo: cells[1], descripcion: cells[2] });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sesión del Explorador (cookie ASP.NET + ViewState vivo)
// ---------------------------------------------------------------------------
export async function openSession(keyinter) {
  const jar = new Jar();
  let url = ASPX + "?keyinter=" + encodeURIComponent(keyinter);
  let html = null;
  for (let hop = 0; hop < 6; hop++) {
    const res = await fetch(url, {
      method: "GET",
      redirect: "manual",
      headers: { Cookie: jar.header(), "User-Agent": UA, Accept: "text/html" },
    });
    jar.store(setCookieOf(res));
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      url = new URL(loc, url).href;
      continue;
    }
    html = await res.text();
    break;
  }
  if (!html) throw new Error("No se pudo abrir el Explorador de Envíos");
  const session = { jar, state: hiddens(html) };
  if (!session.state.__VIEWSTATE)
    throw new Error("Sesión inválida: falta __VIEWSTATE (keyinter vencido?)");
  return session;
}

async function postback(session, extra) {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(session.state)) form.set(k, v);
  form.set("__EVENTTARGET", "");
  form.set("__EVENTARGUMENT", "");
  for (const [k, v] of Object.entries(extra)) form.set(k, v);
  const res = await fetch(ASPX, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: session.jar.header(),
      "User-Agent": UA,
      Referer: ASPX,
    },
    body: form.toString(),
  });
  session.jar.store(setCookieOf(res));
  const html = await res.text();
  const ns = hiddens(html);
  if (ns.__VIEWSTATE) session.state = ns; // refrescar ViewState
  return html;
}

// Pausa entre consultas para no gatillar rate-limit / WAF. Configurable.
export const GUIA_DELAY_MS = Number(process.env.INTER_DELAY_MS ?? 500);
export const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Consulta una guía (equivale al clic en "Rastreo Nacional").
 *
 * Verifica que la página devuelta sea la de la guía pedida. El portal a veces
 * responde con la página anterior —el postback no toma, o el WAF devuelve algo
 * cacheado— y sin este control esos datos se guardaban como si fueran de la
 * guía nueva: el 26/08/2026, 18 envíos quedaron con el destinatario y el
 * teléfono de otra persona, y le llegaron 18 WhatsApp a alguien que no era el
 * dueño de esos paquetes.
 *
 * `tbxNumeroGuia1` es el campo readonly donde el portal repite la guía que
 * esta mostrando: es el unico eco confiable de la consulta.
 *
 * Lanza si no coinciden. Es preferible que la guía quede sin procesar —el
 * worker la reintenta en la próxima corrida— a escribir datos de otro.
 */
export async function queryGuia(session, guia) {
  const html = await postback(session, {
    tbxNumeroGuia: guia,
    btnShow: "Rastreo Nacional",
  });

  const mostrada = inputByName(html, "tbxNumeroGuia1");
  if (mostrada && mostrada.trim() !== String(guia).trim()) {
    throw new Error(
      `El portal respondió con la guía ${mostrada.trim()} en vez de ${guia}`
    );
  }

  return html;
}
// Cambia de pestaña dentro del TabContainer2.
export async function switchTab(session, tabIndex) {
  return postback(session, {
    __EVENTTARGET: "TabContainer2",
    __EVENTARGUMENT: `activeTabChanged:${tabIndex}`,
  });
}
