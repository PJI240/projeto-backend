import mysql from "mysql2/promise";

function resolveMysqlUrl() {
  const url = (process.env.MYSQL_URL || "").trim();
  if (url) return url;

  // fallback com as nativas
  const host = (process.env.MYSQLHOST || "mysql.railway.internal").trim();
  const port = String(process.env.MYSQLPORT || 3306).trim();
  const user = (process.env.MYSQLUSER || "root").trim();
  const pass = (process.env.MYSQLPASSWORD || "").trim();
  const db   = (process.env.MYSQLDATABASE || "railway").trim();

  return `mysql://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}/${db}`;
}

const BASE_DSN = resolveMysqlUrl();
const DSN = BASE_DSN + (BASE_DSN.includes("?") ? "&" : "?") +
  "namedPlaceholders=true&connectionLimit=10";

// Log seguro (sem expor senha) para confirmar em produção
try {
  const masked = DSN.replace(/:[^:@/]+@/, ":******@");
  console.log("MySQL DSN:", masked);
} catch {}

export const pool = mysql.createPool(DSN);
