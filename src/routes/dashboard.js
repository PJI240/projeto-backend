// src/App.jsx (exemplo)
import { BrowserRouter, Routes, Route } from "react-router-dom";
import Dashboard from "./pages/Dashboard.jsx";
// ... outras imports

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* suas rotas */}
        <Route path="/" element={<Dashboard />} />
        <Route path="/dashboard" element={<Dashboard />} />
      </Routes>
    </BrowserRouter>
  );
}
