// src/routes/ocorrencias.js
import { lazy } from "react";

const Ocorrencias = lazy(() => import("../pages/ocorrencias"));

/**
 * Exporta em formato de array para poder dar spread em um routes[] existente.
 * Caso seu roteador use "createBrowserRouter", este objeto é compatível.
 */
const ocorrenciasRoutes = [
  {
    path: "/ocorrencias",
    element: <Ocorrencias />,
    // opcional: meta para menu/ACL
    handle: {
      title: "Ocorrências",
      icon: "ClipboardDocumentListIcon", // apenas referência simbólica
    },
  },
];

export default ocorrenciasRoutes;