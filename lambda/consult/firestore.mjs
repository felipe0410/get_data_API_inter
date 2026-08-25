// Acceso a Firestore compartido por el dispatcher y el worker.
// La credencial llega como JSON en FIREBASE_SA_JSON, igual que en go-pos.
import admin from "firebase-admin";

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SA_JSON)),
  });
}

export const db = admin.firestore();
export const { FieldValue } = admin.firestore;

/** Estados posibles de un job. */
export const ESTADOS = {
  ENCOLADO: "encolado",
  PROCESANDO: "procesando",
  COMPLETADO: "completado",
  ERROR: "error",
};

export const jobRef = (jobId) => db.collection("jobs_consulta").doc(jobId);

/**
 * Registro de guías ya consultadas, un documento por fecha.
 *
 *   envios_procesados/2026-08-25
 *     { oficina: [...guías], domiciliario: [...], jobs: [...] }
 *
 * Un documento por día y no uno por guía: deduplicar cuesta 1 lectura en vez
 * de 200. Con 500 guías el doc pesa ~8 KB contra el límite de 1 MB, y para
 * comparar a ojo se abre uno solo en vez de paginar una colección.
 */
export const procesadosRef = (fecha) =>
  db.collection("envios_procesados").doc(fecha);
