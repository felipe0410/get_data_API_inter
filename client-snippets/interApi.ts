/**
 * Cliente de la API de Interrapidísimo (Lambda + API Gateway).
 * Copiar a: src/lib/interApi.ts en el repo de la web (Next.js).
 *
 * Requiere el route handler de client-snippets/route-inter-token.ts en
 * src/app/api/inter-token/route.ts.
 *
 * .env.local:
 *   NEXT_PUBLIC_INTER_API_URL=https://xxxx.execute-api.us-east-1.amazonaws.com
 *   (esta sí es pública: es solo la URL, y va protegida por el token)
 */

const API_URL = process.env.NEXT_PUBLIC_INTER_API_URL ?? "";

/**
 * Tope de guías por request. Tiene que coincidir con `max_guias` en Terraform
 * (output `max_guias_por_request`). Existe porque el API Gateway corta a los
 * 30s y la consulta es secuencial contra el portal de Inter.
 */
export const MAX_GUIAS_POR_LOTE = 15;

export interface GuiaConsultada {
  guide: string;
  uid: string;
  addressee: string;
  timestamp: number;
  colombiaDate: string;
  deliverTo: string | null;
  shippingCost: string | null;
  status: string;
  intakeDate: string;
  remitente: DatosPersona;
  destinatario: DatosPersona;
  pago: string | null;
  ciudad: string | null;
  servicio: string | null;
  destino: string | null;
  fecha_de_admision: string | null;
  fecha_estimada_de_entrega: string | null;
  [key: string]: unknown;
}

export interface DatosPersona {
  tipo_identificacion: string | null;
  numero_identificacion: string | null;
  nombre: string | null;
  direccion: string | null;
  celular: string | null;
  correo: string | null;
}

// Caché del token en el cliente, además de la que ya hay en el servidor.
let cachedToken: string | null = null;
let tokenExpiresAt = 0;

export async function getInterToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiresAt - 30_000) return cachedToken;

  const res = await fetch("/api/inter-token", { method: "POST" });
  if (!res.ok) throw new Error(`Token error: ${res.status}`);

  const data = await res.json();
  cachedToken = data.access_token as string;
  tokenExpiresAt = Date.now() + data.expires_in * 1000;
  return cachedToken;
}

/** Un solo lote. Falla si `guias` supera MAX_GUIAS_POR_LOTE. */
async function consultarLote(
  guias: string[],
  password: string
): Promise<GuiaConsultada[]> {
  const token = await getInterToken();

  const res = await fetch(`${API_URL}/consult`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ guias, password }),
  });

  if (!res.ok) {
    const detalle = await res.text();
    throw new Error(`consult falló (${res.status}): ${detalle}`);
  }
  return res.json();
}

/**
 * Consulta cualquier cantidad de guías, troceando en lotes.
 *
 * `password` es la del operador en el portal de Inter y viaja en cada request:
 * no es configuración del backend. No la guardes en localStorage ni la pongas
 * en la URL; pedila en el formulario y mantenela en memoria mientras dure la
 * operación.
 *
 * Los lotes van EN SERIE a propósito: cada uno abre su propia sesión contra el
 * portal de Inter, y mandarlos en paralelo es la forma más rápida de que el
 * WAF empiece a rechazar. Con guías de sobra esto tarda, así que `onProgreso`
 * permite ir pintando resultados en vez de dejar la UI congelada.
 */
export async function consultarGuias(
  guias: string[],
  password: string,
  onProgreso?: (parcial: GuiaConsultada[], listas: number, total: number) => void
): Promise<GuiaConsultada[]> {
  const resultados: GuiaConsultada[] = [];

  for (let i = 0; i < guias.length; i += MAX_GUIAS_POR_LOTE) {
    const lote = guias.slice(i, i + MAX_GUIAS_POR_LOTE);
    const datos = await consultarLote(lote, password);
    resultados.push(...datos);
    onProgreso?.(datos, Math.min(i + lote.length, guias.length), guias.length);
  }

  return resultados;
}
