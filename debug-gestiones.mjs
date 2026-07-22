import { chromium } from "playwright";

// Script para debuggear y ver todas las pestañas y contenido
async function debugGestiones() {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto("https://www3.interrapidisimo.com/SitioLogin/auth/login");
  await page.locator("#usernameLogin").fill("aquitania.boyaca");
  await page.locator("#passwordLogin").fill("Lucho1972");
  await page.locator("#botonLogin").click();

  await page.locator('div[title="Explorador Envios"]').waitFor({ state: "visible" });
  await page.locator('div[title="Explorador Envios"]').click();

  let newPage = await context.waitForEvent("page");
  await newPage.waitForLoadState("networkidle");

  // Probar con una guía específica
  const guia = "3000224281709";
  await newPage.locator("#tbxNumeroGuia").fill(guia);
  await newPage.locator("#btnShow").click();
  
  await newPage.waitForSelector('input[name="tbxNombreDes"]', { timeout: 10000 });

  console.log("\n=== DEBUGGEANDO TODAS LAS PESTAÑAS ===");

  // Buscar todas las pestañas disponibles
  const tabs = await newPage.locator('.ajax__tab_tab').all();
  console.log(`Encontradas ${tabs.length} pestañas:`);
  
  for (let i = 0; i < tabs.length; i++) {
    try {
      const tabText = await tabs[i].textContent();
      console.log(`${i + 1}. ${tabText?.trim()}`);
    } catch (e) {
      console.log(`${i + 1}. Error al leer pestaña`);
    }
  }

  // Revisar pestaña Estado
  console.log("\n=== PESTAÑA ESTADO ===");
  try {
    await newPage.locator('#TabContainer2_TabPanel8_tab').click();
    await newPage.waitForTimeout(1000);
    const gestionEnvio = await newPage.inputValue('#TabContainer2_TabPanel8_tbxGestionEnvio');
    console.log(`Gestión del Envío: "${gestionEnvio}"`);
  } catch (e) {
    console.log("Error en pestaña Estado:", e.message);
  }

  // Revisar pestaña Gestion App
  console.log("\n=== PESTAÑA GESTION APP ===");
  try {
    await newPage.locator('#__tab_TabContainer2_TabPanel4').click();
    await newPage.waitForTimeout(1000);
    
    const tableHtml = await newPage.locator('#TabContainer2_TabPanel4_gvGestionApp').innerHTML();
    console.log("HTML de la tabla:");
    console.log(tableHtml);
    
    const rows = await newPage.locator('#TabContainer2_TabPanel4_gvGestionApp tbody tr').all();
    console.log(`\nFilas encontradas: ${rows.length}`);
    
    for (let j = 0; j < rows.length; j++) {
      const rowText = await rows[j].textContent();
      console.log(`Fila ${j}: ${rowText?.trim()}`);
    }
  } catch (e) {
    console.log("Error en pestaña Gestion App:", e.message);
  }

  console.log("\nPresiona Enter para cerrar...");
  await new Promise(resolve => {
    process.stdin.once('data', () => resolve());
  });

  await browser.close();
}

debugGestiones().catch(console.error);