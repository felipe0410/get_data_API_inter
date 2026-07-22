// Script simple para probar una sola guía que sabemos que funciona
const http = require('http');

const data = JSON.stringify({
  guias: ["240042522132", "700177100940", "240042449289"], // Nuevas guías a probar
  password: "Lucho1972" // Cambia esto por la contraseña real
});

const options = {
  hostname: 'localhost',
  port: 8080,
  path: '/entregar',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': data.length
  }
};

console.log('🚀 Probando con las nuevas guías: 240042522132, 700177100940, 240042449289...');

const req = http.request(options, (res) => {
  let responseData = '';
  
  res.on('data', (chunk) => {
    responseData += chunk;
  });
  
  res.on('end', () => {
    console.log('\n✅ RESPUESTA JSON:');
    console.log('='.repeat(50));
    try {
      const jsonResponse = JSON.parse(responseData);
      console.log(JSON.stringify(jsonResponse, null, 2));
    } catch (e) {
      console.log('Raw response:', responseData);
    }
  });
});

req.on('error', (e) => {
  console.error('❌ Error:', e.message);
});

req.write(data);
req.end();