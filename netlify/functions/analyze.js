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

  // Tenta buscar JD pelo link se fornecido e não tiver texto
  if (jobUrl && !jd) {
    try {
      const fetchRes = await fetch(jobUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(5000)
      });
      if (fetchRes.ok) {
        const html = await fetchRes.text();
        finalJD = html
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .substring(0, 4000);
      }
    } catch(e) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Não foi possível acessar o link. Cole o texto da vaga manualmente.' }) };
    }
  }

  // Limita tamanho dos inputs para resposta mais rápida
  const jdTrimmed = finalJD.substring(0, 3000);
  const cvTrimmed = cv.substring(0, 3000);

  const prompt = `Você é especialista em recrutamento brasileiro. Analise o currículo e a vaga. Retorne APENAS JSON válido, sem markdown.

VAGA:
${jdTrimmed}

CURRÍCULO:
${cvTrimmed}

JSON obrigatório:
{
  "empresa": "nome da empresa ou Não identificada",
  "cargo": "título do cargo",
  "fit_score": número de 0 a 100,
  "ats_score": número de 0 a 100,
  "curriculo_reescrito": "currículo completo reescrito com linguagem de impacto, verbos de ação e palavras-chave da vaga. Mínimo 250 palavras.",
  "gaps": [
    {"nivel": "ok", "titulo": "ponto forte", "motivo": "por que é relevante para a vaga"},
    {"nivel": "warn", "titulo": "ajuste sugerido", "motivo": "por que aumenta a compatibilidade"},
    {"nivel": "fix", "titulo": "item ausente", "motivo": "por que a vaga exige isso"}
  ],
  "linkedin_headline": "3 opções de headline separadas por linha",
  "sobre_empresa": "resumo da empresa e faixa salarial estimada em reais"
}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }]
      }),
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const err = await response.text();
      return { statusCode: response.status, body: JSON.stringify({ error: 'Erro na API', detail: err }) };
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

    // Salva resultado com ID único
    const crypto = require('crypto');
    const analysisId = crypto.randomBytes(16).toString('hex');
    try {
      const { getStore } = require('@netlify/blobs');
      const store = getStore('analyses');
      await store.setJSON(analysisId, { ...result, createdAt: Date.now() });
    } catch(e) {
      console.log('Blob save skipped:', e.message);
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
