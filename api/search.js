// Vercel Serverless Function
// Tavily API로 검색 후 Claude API로 결과를 정리합니다

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'q 파라미터가 필요합니다' });

  const tavilyApiKey = process.env.TAVILY_API_KEY;
  const claudeApiKey = process.env.CLAUDE_API_KEY;

  if (!tavilyApiKey || !claudeApiKey) {
    return res.status(500).json({ error: '서버 환경변수가 설정되지 않았습니다' });
  }

  try {
    // ── Step 1. Tavily 검색 ──
    const tavilyRes = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: tavilyApiKey,
        query:   `임산부 임신 중 ${q} 먹어도 되나요 안전`,
        search_depth: 'basic',
        max_results:  5,
        include_answer: false,
      }),
    });

    const tavilyData = await tavilyRes.json();

    if (!tavilyRes.ok) {
      return res.status(tavilyRes.status).json({ error: tavilyData.error || 'Tavily API 오류' });
    }

    const items = (tavilyData.results || []).map(r => ({
      title:   r.title,
      content: r.content,
      url:     r.url,
    }));

    if (items.length === 0) {
      return res.status(200).json({
        food:    q,
        status:  'unknown',
        summary: '관련 정보를 찾지 못했어요',
        detail:  '검색 결과가 없습니다. 담당 산부인과 의사에게 직접 문의하세요.',
        tips:    null,
        sources: [],
      });
    }

    // ── Step 2. Claude API로 정리 ──
    const searchContext = items
      .map((item, i) => `[${i + 1}] ${item.title}\n${item.content}`)
      .join('\n\n');

    const prompt = `당신은 임산부 영양 전문가입니다. 아래 웹 검색 결과를 바탕으로 "${q}"이(가) 임신 중 섭취해도 되는지 분석해 주세요.

[검색 결과]
${searchContext}

반드시 아래 JSON 형식으로만 응답하세요. 마크다운이나 다른 텍스트 없이 JSON만 출력하세요:
{
  "food": "음식 이름",
  "status": "safe" | "caution" | "avoid" | "unknown",
  "summary": "한 줄 요약 (20자 이내)",
  "detail": "상세 설명 (검색 결과 기반, 3~4문장. 임신 중 주의사항, 위험 요소, 영양 정보 포함)",
  "tips": "실용적인 팁 또는 대체 식품 (1~2문장, 없으면 null)"
}

status 기준:
- safe: 임신 중 안전하게 섭취 가능
- caution: 소량·조건부 섭취 가능, 주의 필요
- avoid: 가능하면 피하는 것이 좋음
- unknown: 검색 결과만으로 판단이 어려움`;

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         claudeApiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 600,
        messages:   [{ role: 'user', content: prompt }],
      }),
    });

    const claudeData = await claudeRes.json();

    if (!claudeRes.ok) {
      throw new Error(claudeData.error?.message || 'Claude API 오류');
    }

    const rawText = claudeData.content
      .map(block => block.text || '')
      .join('')
      .replace(/```json|```/g, '')
      .trim();

    const parsed = JSON.parse(rawText);

    return res.status(200).json({
      ...parsed,
      sources: items.map(i => ({ title: i.title, link: i.url })),
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: '검색 중 오류가 발생했습니다: ' + err.message });
  }
}
