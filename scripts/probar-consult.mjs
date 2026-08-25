#!/usr/bin/env node
// Prueba de punta a punta contra la API desplegada:
//   token M2M -> POST /consult -> seguimiento del job en Firestore.
//
// Los secretos se leen de scripts/.prueba.env (gitignoreado), no de la línea
// de comandos, para que no queden en el historial del shell.
//
//   COGNITO_CLIENT_SECRET=...   (consola: Cognito > App clients > Show secret)
//   INTER_PASSWORD=...          (la del portal, la del operador)
//   GUIAS=105600,105601         (opcional, por defecto una de prueba)
//
// Uso:  node scripts/probar-consult.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.join(AQUI, "..");

const TOKEN_URL =
  "https://system-delivery-inter-140862068477-dev.auth.us-east-1.amazoncognito.com/oauth2/token";
const CLIENT_ID = "305s6unsug2fasu344apg7t1th";
const CONSULT = "https://hny3kpr72d.execute-api.us-east-1.amazonaws.com/consult";
const SA = process.env.FIREBASE_SA_PATH;

// --- Cargar secretos ---------------------------------------------------------
const envFile = path.join(AQUI, ".prueba.env");
if (!fs.existsSync(envFile)) {
  console.error(`Falta ${envFile}. Crealo con:

  COGNITO_CLIENT_SECRET=<el secret del app client>
  INTER_PASSWORD=<la contraseña del portal>
`);
  process.exit(1);
}
const env = {};
for (const l of fs.readFileSync(envFile, "utf8").split("\n")) {
  const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
const guias = (env.GUIAS ?? process.env.GUIAS ?? "105600").split(",").map((g) => g.trim());

// --- 1. Token M2M ------------------------------------------------------------
console.log("① Pidiendo token a Cognito…");
const basic = Buffer.from(`${CLIENT_ID}:${env.COGNITO_CLIENT_SECRET}`).toString("base64");
const tRes = await fetch(TOKEN_URL, {
  method: "POST",
  headers: {
    "Content-Type": "application/x-www-form-urlencoded",
    Authorization: `Basic ${basic}`,
  },
  body: "grant_type=client_credentials&scope=inter/consult",
});
if (!tRes.ok) {
  console.error("   ✗", tRes.status, await tRes.text());
  process.exit(1);
}
const { access_token, expires_in } = await tRes.json();
const claims = JSON.parse(Buffer.from(access_token.split(".")[1], "base64").toString());
console.log(`   ✓ token ok — scope="${claims.scope}" client=${claims.client_id} vence en ${expires_in}s`);

// --- 2. Sin token: debe rechazar --------------------------------------------
const sinAuth = await fetch(CONSULT, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ items: guias, password: "x" }),
});
console.log(`② Sin Authorization → ${sinAuth.status} ${sinAuth.status === 401 ? "✓ (rechaza)" : "✗ ¡DEBERÍA SER 401!"}`);

// --- 3. Encolar --------------------------------------------------------------
console.log(`③ Encolando ${guias.length} guía(s): ${guias.join(", ")}`);
const res = await fetch(CONSULT, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${access_token}` },
  body: JSON.stringify({
    items: guias.map((g) => ({ guide: g })),
    password: env.INTER_PASSWORD,
    domiciliary: false,
  }),
});
const cuerpo = await res.text();
console.log(`   HTTP ${res.status}: ${cuerpo}`);
if (res.status !== 202) process.exit(1);
const { jobId } = JSON.parse(cuerpo);

// --- 4. Seguir el job en Firestore ------------------------------------------
if (!SA) {
  console.log(`\n④ Sin FIREBASE_SA_PATH: seguí el job a mano en jobs_consulta/${jobId}`);
  process.exit(0);
}
process.env.FIREBASE_SA_JSON = fs.readFileSync(SA, "utf8");
const { db } = await import(path.join(RAIZ, "lambda/consult/firestore.mjs"));

console.log(`④ Siguiendo jobs_consulta/${jobId} …`);
const ref = db.collection("jobs_consulta").doc(jobId);
const t0 = Date.now();
await new Promise((resolve) => {
  let ultimo = "";
  const stop = ref.onSnapshot((snap) => {
    if (!snap.exists) return;
    const j = snap.data();
    const linea = `   [${String(Math.round((Date.now() - t0) / 1000)).padStart(3)}s] ${j.estado} — ${j.procesadas}/${j.total} procesadas, ${j.guardadas} guardadas, ${j.sinDatos} sin datos, ${j.errores?.length ?? 0} errores, tramo ${j.tramo}`;
    if (linea.slice(10) !== ultimo) { console.log(linea); ultimo = linea.slice(10); }
    if (j.estado === "completado" || j.estado === "error") {
      console.log("\n   resultado final:", JSON.stringify(j, null, 2));
      stop(); resolve();
    }
  });
  setTimeout(() => { console.log("   (timeout de 10 min)"); stop(); resolve(); }, 600_000);
});

// --- 5. Verificar los documentos escritos -----------------------------------
console.log("⑤ Documentos en envios:");
for (const g of guias) {
  const d = await db.collection("envios").doc(g).get();
  console.log(`   ${g}: ${d.exists ? `✓ ${d.data().addressee} — ${d.data().destino ?? "?"}` : "✗ no existe"}`);
}
process.exit(0);
