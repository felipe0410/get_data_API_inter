/**
 * Proxy de token M2M contra Cognito.
 * Copiar a: src/app/api/inter-token/route.ts en el repo de la web (Next.js).
 *
 * Va por el servidor por dos razones: Cognito no manda cabeceras CORS en
 * /oauth2/token, y el client_secret no puede salir del servidor.
 *
 * ⚠️ Las tres variables van SIN el prefijo NEXT_PUBLIC_. En Next.js ese
 * prefijo inlinea el valor en el bundle del navegador, así que un
 * NEXT_PUBLIC_..._CLIENT_SECRET queda legible para cualquiera que abra
 * DevTools, aunque solo se lea desde un route handler.
 *
 * .env.local:
 *   INTER_TOKEN_ENDPOINT=https://system-delivery-inter-140862068477-dev.auth.us-east-1.amazoncognito.com/oauth2/token
 *   INTER_CLIENT_ID=...
 *   INTER_CLIENT_SECRET=...
 */
import { NextResponse } from "next/server";

const TOKEN_ENDPOINT = process.env.INTER_TOKEN_ENDPOINT ?? "";
const CLIENT_ID = process.env.INTER_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.INTER_CLIENT_SECRET ?? "";

// Caché en el servidor. El token dura 1h; se renueva 30s antes de vencer.
let cachedToken: string | null = null;
let tokenExpiresAt = 0;

export async function POST() {
  try {
    if (cachedToken && Date.now() < tokenExpiresAt - 30_000) {
      return NextResponse.json({
        access_token: cachedToken,
        expires_in: Math.floor((tokenExpiresAt - Date.now()) / 1000),
      });
    }

    if (!TOKEN_ENDPOINT || !CLIENT_ID || !CLIENT_SECRET) {
      return NextResponse.json(
        { error: "Faltan variables de entorno de Cognito para Inter" },
        { status: 500 }
      );
    }

    const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString(
      "base64"
    );

    const res = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${credentials}`,
      },
      body: "grant_type=client_credentials&scope=inter/consult",
    });

    if (!res.ok) {
      const details = await res.text();
      console.error("Cognito token error:", res.status, details);
      return NextResponse.json(
        { error: "Error al obtener token", status: res.status },
        { status: res.status }
      );
    }

    const data = await res.json();
    cachedToken = data.access_token;
    tokenExpiresAt = Date.now() + data.expires_in * 1000;

    return NextResponse.json({
      access_token: data.access_token,
      expires_in: data.expires_in,
    });
  } catch (error) {
    console.error("Error en proxy de token de Inter:", error);
    return NextResponse.json({ error: "Error interno del servidor" }, { status: 500 });
  }
}
