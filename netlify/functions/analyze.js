exports.handler = async function (event) {
  // Só aceita POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // Chave da API vem da variável de ambiente do Netlify
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Chave de API não configurada.' })
    };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'JSON inválido.' }) };
  }

  const { jd, cv } = body;
  if (!jd || !cv) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Campos jd e cv são obrigatórios.' })
    };
  }

  const prompt = `Você é um especialista em recrutamento e reescrita de currículos para o mercado brasileiro.

Analise o currículo e a descrição da vaga abaixo. Retorne APENAS um objeto JSON válido, sem markdown, sem texto antes ou depois, sem comentários.

DESCRIÇÃO DA VAGA:
${jd}

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
    {
      "nivel": "ok",
      "titulo": "ponto forte identificado",
      "motivo": "por que este ponto é relevante para a vaga"
    },
    {
      "nivel": "warn",
      "titulo": "ajuste sugerido",
      "motivo": "por que este ajuste aumenta a compatibilidade"
    },
    {
      "nivel": "fix",
      "titulo": "item ausente e necessário",
      "motivo": "por que este item é exigido pela vaga"
    }
  ],
  "linkedin_headline": "3 sugestões de headline do LinkedIn separadas por \\n\\n---\\n\\n",
  "sobre_empresa": "resumo sobre a empresa: cultura, porte, setor, presença no mercado e faixa salarial estimada para a posição com base em fontes públicas brasileiras"
}

Regras obrigatórias:
- fit_score abaixo de 50 é baixo, 50 a 74 é médio, 75 a 100 é alto
- ats_score mede presença de palavras-chave da vaga no currículo reescrito
- gaps deve ter entre 3 e 5 itens, com pelo menos um de cada nível
- curriculo_reescrito deve ter pelo menos 300 palavras
- sobre_empresa deve mencionar faixa salarial estimada em reais
- Responda em português brasileiro`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'tools-2024-04-04'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [
          {
            role: 'user',
            content: `${prompt}\n\nUse web_search para buscar informações sobre a empresa "${jd.substring(0, 80)}" e faixa salarial para a posição no Brasil antes de responder.`
          }
        ]
      })
    });

    if (!response.ok) {
      const err = await response.text();
      return {
        statusCode: response.status,
        body: JSON.stringify({ error: 'Erro na API Anthropic', detail: err })
      };
    }

    const data = await response.json();

    // Extrai texto dos blocos de conteúdo
    let text = '';
    for (const block of data.content || []) {
      if (block.type === 'text') text += block.text;
    }

    // Parse JSON da resposta
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'Resposta inválida da IA', raw: text.substring(0, 500) })
      };
    }

    const result = JSON.parse(text.substring(start, end + 1));

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify(result)
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Erro interno', detail: err.message })
    };
  }
};
