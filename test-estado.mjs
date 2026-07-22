import { chromium } from "playwright";

// Script de prueba para identificar dónde está el estado de la guía
async function testEstado() {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto("https://www3.interrapidisimo.com/SitioLogin/auth/login");
  
  console.log("Por favor ingresa manualmente:");
  console.log("1. Usuario y contraseña");
  console.log("2. Ve a Explorador Envios");
  console.log("3. Ingresa una guía de prueba");
  console.log("4. Presiona Enter en la consola cuando esté lista la información");
  
  // Esperar input del usuario
  await new Promise(resolve => {
    process.stdin.once('data', () => resolve());
  });

  // Intentar encontrar elementos que contengan información de estado
  const possibleSelectors = [
    'input[name*="estado"]',
    'input[name*="Estado"]',
    'input[name*="status"]',
    'input[name*="Status"]',
    'input[value*="entregado"]',
    'input[value*="Entregado"]',
    'input[value*="devolucion"]',
    'input[value*="Devolucion"]',
    'input[value*="oficina"]',
    'input[value*="Oficina"]',
    'span:has-text("Estado")',
    'label:has-text("Estado")',
    'td:has-text("Estado")',
  ];

  console.log("\n=== BUSCANDO ELEMENTOS DE ESTADO ===");
  
  for (const selector of possibleSelectors) {
    try {
      const elements = await page.locator(selector).all();
      if (elements.length > 0) {
        console.log(`\n✅ Encontrado: ${selector}`);
        for (let i = 0; i < elements.length; i++) {
          const value = await elements[i].inputValue().catch(() => null);
          const text = await elements[i].textContent().catch(() => null);
          console.log(`  Elemento ${i}: value="${value}", text="${text}"`);
        }
      }
    } catch (error) {
      // Ignorar errores de selectores no válidos
    }
  }

  // También buscar todos los inputs para ver sus nombres
  console.log("\n=== TODOS LOS INPUTS ===");
  const allInputs = await page.locator('input').all();
  for (let i = 0; i < Math.min(allInputs.length, 20); i++) {
    const name = await allInputs[i].getAttribute('name');
    const value = await allInputs[i].inputValue().catch(() => '');
    if (name && value) {
      console.log(`Input: name="${name}", value="${value}"`);
    }
  }

  console.log("\nPresiona Enter para cerrar...");
  await new Promise(resolve => {
    process.stdin.once('data', () => resolve());
  });

  await browser.close();
}

testEstado().catch(console.error);