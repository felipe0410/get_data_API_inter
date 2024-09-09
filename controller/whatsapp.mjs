import { chromium,firefox } from "playwright";

export default async function run() {
  const browser = await firefox.launch({
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process',
    ],
  });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto("https://web.whatsapp.com/");

  // Espera a que el usuario inicie sesión
  await page.waitForSelector('h1[class*="x1qlqyl8 x1pd3egz xcgk4ki"]', {
    timeout: 60000 * 5, // Esperar hasta 5 minutos
  });

  console.log('Sesión iniciada, buscando el chat de "Yo"...');

  // Selecciona el chat con el título "Yo"
  await page.click('span[title="Yo"]');

  console.log("Chat seleccionado, escribiendo mensaje...");

  // Selecciona la barra de mensajes usando aria-label y escribe el número de teléfono
  await page.waitForSelector('div[aria-label="Escribe un mensaje"]', {
    timeout: 10000,
  });
  await page.type('div[aria-label="Escribe un mensaje"]', "3125607423");
  await page.keyboard.press("Enter");

  console.log(
    "Mensaje enviado, esperando para seleccionar el mensaje enviado..."
  );

  // Espera a que el mensaje enviado aparezca en la lista de mensajes
  await page.waitForSelector(
    'span[class*="selectable-text copyable-text"] >> text="3125607423"',
    { timeout: 10000 }
  );
  await page.click(
    'span[class*="selectable-text copyable-text"] >> text="3125607423"'
  );

  console.log('Mensaje seleccionado, buscando botón de "Chatear conmigo"...');

  // Haz clic en el botón de "Chatear conmigo"
  await page.click('div[role="button"] >> text="Chatear con"');

  console.log("Esperando a ingresar al chat...");

  // Espera a que el nuevo chat se abra
  await page.waitForSelector('div[aria-label="Escribe un mensaje"]', {
    timeout: 10000,
  });

  // Escribe un mensaje en el nuevo chat
  await page.type(
    'div[aria-label="Escribe un mensaje"]',
    "Es una prueba de Playwright"
  );
  await page.keyboard.press("Enter");

  console.log("Mensaje enviado en el nuevo chat");

  // Esperar un momento antes de cerrar el navegador para asegurar que el mensaje se envíe
  await page.waitForTimeout(3000);

  await browser.close();
  console.log("Navegador cerrado");
}

// Ejecutar la función
run().catch((error) => {
  console.error("Error:", error);
});
