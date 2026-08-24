/**
 * Cliente de la API de Interrapidísimo (API Gateway + Lambda).
 * Copiar a: src/lib/interApi.ts en el repo de la web (Next.js).
 *
 * Requiere el route handler de client-snippets/route-inter-token.ts en
 * src/app/api/inter-token/route.ts.
 *
 * .env.local:
 *   NEXT_PUBLIC_INTER_API_URL=https://xxxx.execute-api.us-east-1.amazonaws.com
 *   (esta sí es pública: es solo la URL, y va protegida por el token)
 *
 * ─── Cómo funciona ────────────────────────────────────────────────────────
 * La API responde 202 con un jobId y sigue trabajando por su cuenta. No hay
 * nada que esperar: el worker escribe los documentos finales en `envios/{guia}`
 * y publica el progreso en `jobs_consulta/{jobId}`. La web se suscribe a ese
 * doc y pinta el avance.
 *
 * Eso es lo que saca el trabajo de la ventana de 30s del API Gateway: si la
 * pestaña se cierra a la mitad, el job sigue igual y los envíos quedan
 * guardados.
 */
import { doc, onSnapshot } from "firebase/firestore";
import { db } from "@/firebase/firebase";

const API_URL = process.env.NEXT_PUBLIC_INTER_API_URL ?? "";

export interface ItemConsulta {
  guide: string;
  /** Los extras del formulario. El worker los mergea con lo que trae Inter. */
  valor?: number | null;
  box?: string | null;
  packageNumber?: number | null;
  revision?: boolean | null;
  pago?: string | null;
  shippingCost?: string | null;
}

export type EstadoJob = "encolado" | "procesando" | "completado" | "error";

export interface ProgresoJob {
  jobId: string;
  estado: EstadoJob;
  total: number;
  procesadas: number;
  guardadas: number;
  sinDatos: number;
  errores: { guia?: string; etapa?: string; message: string }[];
  /** Tramo actual. Sube si el job no entró en una sola corrida del worker. */
  tramo: number;
  /** Promedio real por guía. Útil para calibrar expectativas. */
  msPorGuia: number | null;
}

export interface RespuestaEncolado {
  jobId: string;
  total: number;
  duplicadasDescartadas: number;
  coleccionJob: string;
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

/**
 * Encola la consulta. Vuelve en cuanto la API acepta el trabajo, no cuando
 * termina.
 *
 * `password` es la del operador en el portal de Inter y viaja en la request.
 * No la guardes en localStorage ni la pongas en la URL: pedila en el
 * formulario y mantenela en memoria mientras dure la operación.
 */
export async function encolarConsulta(
  items: ItemConsulta[],
  password: string,
  domiciliary: boolean
): Promise<RespuestaEncolado> {
  const token = await getInterToken();

  const res = await fetch(`${API_URL}/consult`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ items, password, domiciliary }),
  });

  if (!res.ok) {
    const detalle = await res.text();
    throw new Error(`No se pudo encolar la consulta (${res.status}): ${detalle}`);
  }
  return res.json();
}

/**
 * Sigue un job en vivo. Devuelve la función para desuscribirse.
 *
 * `onCambio` se llama en cada actualización; `onFin` una sola vez cuando el
 * job llega a completado o error.
 */
export function seguirJob(
  jobId: string,
  onCambio: (p: ProgresoJob) => void,
  onFin?: (p: ProgresoJob) => void
): () => void {
  let terminado = false;

  return onSnapshot(doc(db, "jobs_consulta", jobId), (snap) => {
    if (!snap.exists()) return;
    const p = snap.data() as ProgresoJob;
    onCambio(p);

    if (!terminado && (p.estado === "completado" || p.estado === "error")) {
      terminado = true;
      onFin?.(p);
    }
  });
}

/**
 * Envoltorio para el caso simple: encolar y esperar a que termine.
 *
 * Ojo: esto vuelve a atar el resultado a que la pestaña siga abierta. Sirve
 * para un botón que muestra una barra de progreso, pero si lo que querés es
 * disparar y olvidarte, usá encolarConsulta + seguirJob por separado.
 */
export function consultarYEsperar(
  items: ItemConsulta[],
  password: string,
  domiciliary: boolean,
  onProgreso?: (p: ProgresoJob) => void
): Promise<ProgresoJob> {
  return new Promise(async (resolve, reject) => {
    try {
      const { jobId } = await encolarConsulta(items, password, domiciliary);
      const cortar = seguirJob(
        jobId,
        (p) => onProgreso?.(p),
        (p) => {
          cortar();
          p.estado === "error"
            ? reject(new Error(p.errores?.[0]?.message ?? "El job falló"))
            : resolve(p);
        }
      );
    } catch (e) {
      reject(e);
    }
  });
}
