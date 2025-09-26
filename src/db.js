import mysql from "mysql2/promise";

console.log('🔍 Configurando conexão com banco...');
console.log('DATABASE_URL:', process.env.DATABASE_URL ? '✅ Configurada' : '❌ Não encontrada');

// Conexão direta para Railway
const pool = mysql.createPool({
  uri: process.env.DATABASE_URL,
  waitForConnections: true,
  connectionLimit: 10,
  namedPlaceholders: true,
  connectTimeout: 10000,
  acquireTimeout: 10000,
  timeout: 10000,
});

// Teste de conexão
pool.getConnection()
  .then((connection) => {
    console.log('✅ Conectado ao MySQL com sucesso!');
    connection.release();
  })
  .catch((error) => {
    console.error('❌ Erro de conexão MySQL:');
    console.error('Mensagem:', error.message);
    console.error('Código:', error.code);
    console.error('Endereço:', error.address, 'Porta:', error.port);
  });

export { pool };
