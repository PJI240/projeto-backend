#!/usr/bin/env node
// scripts/backfill-admin.js
// Garante que toda empresa tenha o perfil "Administrador" ativo (idempotente)

import { pool } from "../src/db.js";
import { backfillAdminProfiles } from "../src/lib/roles.js";

async function main() {
  console.log("🔧 Iniciando backfill de perfis Administrador em todas as empresas…");
  const start = Date.now();

  await backfillAdminProfiles();

  const ms = Date.now() - start;
  console.log(`✅ Concluído em ${ms}ms`);
}

main()
  .then(async () => {
    await pool.end().catch(() => {});
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("❌ Erro no backfill:", err?.message || err);
    await pool.end().catch(() => {});
    process.exit(1);
  });