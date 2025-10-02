// No arquivo Escalas.jsx, substitua a função salvarEscalasMultiplas:

const salvarEscalasMultiplas = async () => {
  setErr("");
  setSucesso("");
  setLoading(true);
  
  try {
    if (!formMultiplo.funcionario_id || formMultiplo.datas.length === 0) {
      throw new Error("Selecione funcionário e pelo menos uma data.");
    }

    // Preparar array de escalas para o batch
    const escalasBatch = formMultiplo.datas.map(data => ({
      funcionario_id: Number(formMultiplo.funcionario_id),
      data: data,
      turno_ordem: Number(formMultiplo.turno_ordem) || 1,
      entrada: formMultiplo.entrada || null,
      saida: formMultiplo.saida || null,
      origem: formMultiplo.origem || "FIXA",
    }));

    console.log('💾 Salvando escalas em lote:', escalasBatch.length, 'escalas');

    // Usar o novo endpoint batch
    const resultado = await api(`/api/escalas/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ escalas: escalasBatch }),
    });

    setSucesso(resultado.message || `${escalasBatch.length} escalas adicionadas com sucesso!`);
    setModalMultiploAberto(false);
    await carregarEscalas();
    
  } catch (e) {
    console.error('❌ Erro ao salvar escalas múltiplas:', e);
    setErr(e.message || "Falha ao salvar escalas.");
  } finally {
    setLoading(false);
  }
};
