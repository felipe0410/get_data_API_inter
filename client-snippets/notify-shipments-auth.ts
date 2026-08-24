/**
 * Autenticación para /api/whatsapp/notify-shipments.
 * Aplicar en: src/app/api/whatsapp/notify-shipments/route.ts (repo de la web).
 *
 * ─── Por qué ──────────────────────────────────────────────────────────────
 * Hoy la ruta es un POST abierto: cualquiera que sepa la URL puede mandarle un
 * arreglo de shipments y disparar plantillas de WhatsApp a costa tuya. Mientras
 * la llamaba solo el navegador de un operador logueado eso pasaba desapercibido;
 * ahora la llama el worker desde AWS, así que conviene cerrarla.
 *
 * El mismo valor va en el secret NOTIFY_TOKEN de GitHub (que Terraform le pasa
 * al worker) y en la variable de entorno de la web. Sin prefijo NEXT_PUBLIC_:
 * ese prefijo lo inlinearía en el bundle del navegador.
 *
 * Generar uno:  openssl rand -hex 32
 *
 * .env.local de la web:
 *   NOTIFY_TOKEN=<el mismo valor>
 */

// ─── 1. Agregar arriba del archivo ────────────────────────────────────────
const NOTIFY_TOKEN = process.env.NOTIFY_TOKEN ?? "";

/**
 * Comparación en tiempo constante, para no filtrar el token por cuánto tarda
 * en fallar. Con === un atacante puede ir adivinando carácter por carácter.
 */
function tokenValido(recibido: string | null): boolean {
  if (!NOTIFY_TOKEN || !recibido) return false;
  if (recibido.length !== NOTIFY_TOKEN.length) return false;
  let diff = 0;
  for (let i = 0; i < NOTIFY_TOKEN.length; i++) {
    diff |= NOTIFY_TOKEN.charCodeAt(i) ^ recibido.charCodeAt(i);
  }
  return diff === 0;
}

// ─── 2. Como primeras líneas del POST, antes de leer el body ──────────────
//
// export async function POST(req: NextRequest) {
//   if (!tokenValido(req.headers.get("x-notify-token"))) {
//     return NextResponse.json({ success: false, error: "No autorizado" }, { status: 401 });
//   }
//   try {
//     const body = await req.json();
//     ...
//
// ─── 3. Ojo con quién más la llama ────────────────────────────────────────
//
// getData/page.tsx la llama hoy desde el navegador (notifySavedShipments). Si
// el worker pasa a encargarse del envío, ese llamado sobra y hay que sacarlo:
// si no, cada envío se notificaría dos veces. Y si se deja, tiene que mandar
// la cabecera — pero entonces el token viajaría al navegador, que es justo lo
// que se quiere evitar. La salida limpia es que notifique solo el worker.

export { tokenValido };
