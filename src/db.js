import mysql from "mysql2/promise";
const host = process.env.DB_HOST || process.env.MYSQLHOST || "localhost";
const port = Number(process.env.DB_PORT || process.env.MYSQLPORT || 3306);
const user = process.env.DB_USER || process.env.MYSQLUSER || "root";
const password = process.env.DB_PASSWORD || process.env.MYSQLPASSWORD || "";
const database = process.env.DB_NAME || process.env.MYSQLDATABASE || "railway";

export const pool = mysql.createPool({
  host,
  port,
  user,
  password,
  database,
  waitForConnections: true,
  connectionLimit: 10,
  namedPlaceholders: true,
});
