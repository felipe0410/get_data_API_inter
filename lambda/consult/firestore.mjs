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
