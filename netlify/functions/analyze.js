const crypto = require('crypto');

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Chave de API não configurada.' }) };
  }

  let body;
  try { body = JSON.parse(event.body); } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'JSON inválido.' }) };
  }

  const { jd, cv, jobUrl } = body;
  if ((!jd && !jobUrl) || !cv) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Vaga e currículo são obrigatórios.' }) };
  }

  let finalJD = jd || '';

  // Tenta buscar JD pelo link se fornecido
  if (jobUrl && !jd) {
    try {
      const fetchRes = await fetch(jobUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AquelaVaga/1.0)' },
        signal: AbortSignal.timeout(8000)
      });
      if (fetchRes.ok) {
        const html = await fetchRes.text();
        // Extrai texto básico removendo tags HTML
        finalJD = html
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .substring(0, 8000);
      }
    } catch(e) {
      console.log('Fetch URL error:', e.message);
      if (!finalJD) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Não foi possível acessar o link da vaga. Cole o texto manualmente.' }) };
      }
    }
  }

  const prompt = `Você é um especialista em recrutamento e reescrita de currículos para o mercado brasileiro.

Analise o currículo e a descrição da vaga abaixo. Retorne APENAS um objeto JSON válido, sem markdown, sem texto antes ou depois.

DESCRIÇÃO DA VAGA:
${finalJD}

CURRÍCULO:
${cv}

Retorne exatamente este JSON:
{
  "empresa": "nome da empresa extraído da vaga ou 'Não identificada'",
  "cargo": "título do cargo",
  "fit_score": número inteiro de 0 a 100,
  "ats_score": número inteiro de 0 a 100,
  "curriculo_reescrito": "versão completa do currículo reescrita e alinhada à vaga. Use linguagem de impacto, verbos de ação, palavras-chave da JD. Mantenha apenas fatos reais do currículo original. Formate com quebras de linha.",
  "gaps": [
    { "nivel": "ok", "titulo": "ponto forte identificado", "motivo": "por que este ponto é relevante para a vaga" },
    { "nivel": "warn", "titulo": "ajuste sugerido", "motivo": "por que este ajuste aumenta a compatibilidade" },
    { "nivel": "fix", "titulo": "item ausente e necessário", "motivo": "por que este item é exigido pela vaga" }
  ],
  "linkedin_headline": "3 sugestões de headline do LinkedIn separadas por linha",
  "sobre_empresa": "resumo sobre a empresa: cultura, porte, setor e faixa salarial estimada para a posição em reais"
}

Regras: fit_score abaixo de 50 é baixo, 50-74 médio, 75+ alto. gaps deve ter 3 a 5 itens. curriculo_reescrito deve ter pelo menos 300 palavras. Responda em português brasileiro.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const err = await response.text();
      return { statusCode: response.status, body: JSON.stringify({ error: 'Erro na API Anthropic', detail: err }) };
    }

    const data = await response.json();
    let text = '';
    for (const block of data.content || []) {
      if (block.type === 'text') text += block.text;
    }

    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1) {
      return { statusCode: 500, body: JSON.stringify({ error: 'Resposta inválida da IA' }) };
    }

    const result = JSON.parse(text.substring(start, end + 1));

    // Salva resultado com ID único para recuperar depois do magic link
    const analysisId = crypto.randomBytes(16).toString('hex');
    try {
      const { getStore } = require('@netlify/blobs');
      const store = getStore('analyses');
      await store.setJSON(analysisId, { ...result, createdAt: Date.now() });
    } catch(e) {
      console.log('Blob save error:', e.message);
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ ...result, analysisId })
    };
  } catch(err) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Erro interno', detail: err.message }) };
  }
};
