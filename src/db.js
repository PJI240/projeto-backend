export const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,   // <<< usa a porta do Railway
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  namedPlaceholders: true
});
