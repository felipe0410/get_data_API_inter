const axios = require('axios');

async function testEntregar() {
  const guias = [
    "4004300192370017996987",
    "9700179948831",
    "700179928535",
    "700179919813",
    "700179893286",
    "700179886279"
  ];

  const payload = {
    guias: guias,
    password: "Lucho1972" // Necesitas poner la contraseña real
  };

  try {
    console.log('🚀 Iniciando prueba del endpoint /entregar...');
    console.log(`📦 Consultando ${guias.length} guías:`);
    guias.forEach((guia, index) => {
      console.log(`   ${index + 1}. ${guia}`);
    });
    console.log('\n⏳ Enviando petición...\n');

    const response = await axios.post('http://localhost:8080/entregar', payload, {
      timeout: 300000 // 5 minutos de timeout
    });

    console.log('✅ RESPUESTA RECIBIDA:');
    console.log('='.repeat(50));
    console.log(JSON.stringify(response.data, null, 2));
    
  } catch (error) {
    console.error('❌ ERROR:', error.message);
    if (error.response) {
      console.error('Status:', error.response.status);
      console.error('Data:', error.response.data);
    }
  }
}

testEntregar();