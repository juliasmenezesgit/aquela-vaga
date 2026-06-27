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

  function friendlyError(status, errBody) {
    if (status === 503 || status === 529) {
      return 'Serviço temporariamente sobrecarregado. Tente novamente em instantes.';
    }
    if (status === 429) {
      return 'Muitas requisições simultâneas. Aguarde alguns segundos e tente novamente.';
    }
    if (errBody && (errBody.includes('credit') || errBody.includes('balance') || errBody.includes('authentication'))) {
      return 'Serviço temporariamente indisponível. Tente mais tarde.';
    }
    return 'Erro inesperado. Tente novamente em instantes.';
  }

  try {
    const startTime = Date.now();
    // Tenta haiku primeiro; se sobrecarregado (503/529), cai pro sonnet
    const models = ['claude-haiku-4-5', 'claude-sonnet-4-6'];
    let finalResponse = null;
    let lastStatus = null;
    let lastErrBody = null;

    for (const model of models) {
      const elapsed = Date.now() - startTime;
      const remaining = 23000 - elapsed;
      if (remaining < 2000) break;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), remaining);

      try {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': ANTHROPIC_KEY,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model,
            max_tokens: 2000,
            messages: [{ role: 'user', content: prompt }]
          }),
          signal: controller.signal
        });
        clearTimeout(timeout);

        if (response.ok) {
          finalResponse = response;
          break;
        }

        lastStatus = response.status;
        lastErrBody = await response.text();

        // Só tenta o próximo modelo em caso de sobrecarga
        if (lastStatus !== 503 && lastStatus !== 529) break;
      } catch(e) {
        clearTimeout(timeout);
        if (e.name === 'AbortError') {
          return { statusCode: 504, body: JSON.stringify({ error: 'A análise demorou muito. Tente novamente.' }) };
        }
        throw e;
      }
    }

    if (!finalResponse) {
      return { statusCode: 503, body: JSON.stringify({ error: friendlyError(lastStatus, lastErrBody) }) };
    }

    const data = await finalResponse.json();
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

    // Salva no Supabase (service_role bypassa RLS)
    let analysisId = null;
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (SUPABASE_URL && SUPABASE_KEY) {
      try {
        const sbRes = await fetch(`${SUPABASE_URL}/rest/v1/analyses`, {
          method: 'POST',
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=representation'
          },
          body: JSON.stringify({
            empresa: result.empresa,
            cargo: result.cargo,
            fit_score: result.fit_score,
            ats_score: result.ats_score,
            curriculo_reescrito: result.curriculo_reescrito,
            gaps: result.gaps,
            linkedin_headline: result.linkedin_headline,
            sobre_empresa: result.sobre_empresa
          })
        });
        if (sbRes.ok) {
          const [row] = await sbRes.json();
          analysisId = row?.id;
        }
      } catch(e) {
        console.log('Supabase save skipped:', e.message);
      }
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ ...result, analysisId })
    };
  } catch(err) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Erro inesperado. Tente novamente em instantes.' }) };
  }
};
