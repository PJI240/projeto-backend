const sequelize = require('../config/database');

console.log("Testando DB");

(async () => {
  try {
    await sequelize.authenticate();
    console.log('Conexão com o DB: OK');
    await sequelize.close();
    process.exit(0)
  } catch (err) {
    console.error('Erro ao conectar ao DB:', err);
    process.exit(1);
  }
})();
