#!/usr/bin/env node
// Prueba de fuego: corre las guías reales de un guardado_rapido por la Lambda
// en modo prueba (escribe en envios_prueba, sin WhatsApp) y compara el
// resultado, campo por campo, con lo que ya hay en envios.
//
// Uso: node scripts/prueba-fuego.mjs [fecha] [tipo]
//      node scripts/prueba-fuego.mjs 2026-08-24 oficina
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const FECHA = process.argv[2] ?? "2026-08-24";
const TIPO = process.argv[3] ?? "oficina";

const TOKEN_URL =
  "https://system-delivery-inter-140862068477-dev.auth.us-east-1.amazoncognito.com/oauth2/token";
const CLIENT_ID = "305s6unsug2fasu344apg7t1th";
const CONSULT = "https://hny3kpr72d.execute-api.us-east-1.amazonaws.com/consult";

const env = {};
for (const l of fs.readFileSync(path.join(AQUI, ".prueba.env"), "utf8").split("\n")) {
  const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
process.env.FIREBASE_SA_JSON = fs.readFileSync(process.env.FIREBASE_SA_PATH, "utf8");
const { db } = await import(path.join(AQUI, "../lambda/consult/firestore.mjs"));

// --- 1. Traer las guías del guardado rápido ---------------------------------
const col = db.collection("guardado_rapido").doc(FECHA).collection(TIPO);
const items = (await col.get()).docs.map((d) => ({
  guide: d.id,
  valor: d.data().valor ?? null,
  box: d.data().box ?? null,
  packageNumber: d.data().packageNumber ?? null,
  revision: d.data().revision ?? null,
  pago: d.data().pago ?? null,
  shippingCost: d.data().shippingCost ?? null,
}));
console.log(`① ${items.length} guías en /guardado_rapido/${FECHA}/${TIPO}`);

// --- 2. Encolar en modo prueba ----------------------------------------------
const basic = Buffer.from(`${CLIENT_ID}:${env.COGNITO_CLIENT_SECRET}`).toString("base64");
const tRes = await fetch(TOKEN_URL, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${basic}` },
  body: "grant_type=client_credentials&scope=inter/consult",
});
const { access_token } = await tRes.json();

const res = await fetch(CONSULT, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${access_token}` },
  body: JSON.stringify({
    items,
    password: env.INTER_PASSWORD,
    domiciliary: TIPO === "domiciliario",
    modoPrueba: true,
  }),
});
const cuerpo = await res.text();
console.log(`② HTTP ${res.status}: ${cuerpo}`);
if (res.status !== 202) process.exit(1);
const { jobId } = JSON.parse(cuerpo);

// --- 3. Seguir el job -------------------------------------------------------
const t0 = Date.now();
const job = await new Promise((resolve) => {
  let ultimo = "";
  const stop = db.collection("jobs_consulta").doc(jobId).onSnapshot((snap) => {
    if (!snap.exists) return;
    const j = snap.data();
    const l = `   [${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s] ${j.estado} — ${j.procesadas}/${j.total}, ${j.guardadas} guardadas, ${j.sinDatos} sin datos, ${j.errores?.length ?? 0} errores, tramo ${j.tramo}`;
    if (l.slice(11) !== ultimo) { console.log(l); ultimo = l.slice(11); }
    if (j.estado === "completado" || j.estado === "error") { stop(); resolve(j); }
  });
  setTimeout(() => { stop(); resolve(null); }, 900_000);
});
console.log(`③ job: ${job?.estado} — msLogin=${job?.msLogin} msPorGuia=${job?.msPorGuia}`);
if (job?.errores?.length) console.log("   errores:", JSON.stringify(job.errores.slice(0, 5), null, 1));

// --- 4. Comparar campo por campo -------------------------------------------
console.log("\n④ Comparando envios_prueba contra envios…\n");
// Campos que cambian por diseño en cada corrida: no son diferencias reales.
const VOLATILES = new Set([
  "intakeDate", "fecha_de_admision_timestamp", "fecha_de_admision_timestamp_local",
  "timestamp", "colombiaDate", "updateDate",
]);

const difs = new Map();      // campo -> [{guia, viejo, nuevo}]
let iguales = 0, faltantes = [], soloNuevo = [];

for (const it of items) {
  const [a, b] = await Promise.all([
    db.collection("envios").doc(it.guide).get(),
    db.collection("envios_prueba").doc(it.guide).get(),
  ]);
  if (!b.exists) { faltantes.push(it.guide); continue; }
  if (!a.exists) { soloNuevo.push(it.guide); continue; }

  const viejo = a.data(), nuevo = b.data();
  const campos = new Set([...Object.keys(viejo), ...Object.keys(nuevo)]);
  let difEste = 0;
  for (const c of campos) {
    if (VOLATILES.has(c)) continue;
    const v = JSON.stringify(viejo[c] ?? null), n = JSON.stringify(nuevo[c] ?? null);
    if (v !== n) {
      if (!difs.has(c)) difs.set(c, []);
      difs.get(c).push({ guia: it.guide, viejo: viejo[c] ?? null, nuevo: nuevo[c] ?? null });
      difEste++;
    }
  }
  if (!difEste) iguales++;
}

console.log(`documentos idénticos     : ${iguales}/${items.length}`);
console.log(`no escritos por la Lambda: ${faltantes.length}${faltantes.length ? " → " + faltantes.slice(0,8).join(", ") : ""}`);
console.log(`solo en envios_prueba    : ${soloNuevo.length}`);

if (difs.size) {
  console.log("\ndiferencias por campo:");
  for (const [campo, lista] of [...difs].sort((x, y) => y[1].length - x[1].length)) {
    console.log(`\n  ${campo}  (${lista.length} guías)`);
    for (const d of lista.slice(0, 3)) {
      console.log(`    ${d.guia}:  viejo=${JSON.stringify(d.viejo)}`);
      console.log(`    ${" ".repeat(d.guia.length)}   nuevo=${JSON.stringify(d.nuevo)}`);
    }
    if (lista.length > 3) console.log(`    … y ${lista.length - 3} más`);
  }
} else {
  console.log("\n✅ sin diferencias fuera de los campos volátiles");
}
process.exit(0);
