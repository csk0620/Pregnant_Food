// Vercel Serverless Function
// 네이버 검색 API로 한국어 콘텐츠 수집 후 Claude로 분석합니다

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'q 파라미터가 필요합니다' });

  const naverClientId     = process.env.NAVER_CLIENT_ID;
  const naverClientSecret = process.env.NAVER_CLIENT_SECRET;
  const claudeApiKey      = process.env.CLAUDE_API_KEY;

  if (!naverClientId || !naverClientSecret || !claudeApiKey) {
    return res.status(500).json({ error: '서버 환경변수가 설정되지 않았습니다' });
  }

  try {
    // Step 1. 네이버 블로그 + 지식iN 병렬 검색
    // 블로그: "임산부 {음식} 음식 먹어도 되나요" — 실제 경험 위주
    // 지식iN: "임산부 {음식} 섭취 안전" — Q&A 전문 답변 위주
    const blogQuery = encodeURIComponent(`임산부 ${q} 음식 먹어도 되나요`);
    const kinQuery  = encodeURIComponent(`임산부 ${q} 섭취 안전`);
    const naverHeaders = {
      'X-Naver-Client-Id':     naverClientId,
      'X-Naver-Client-Secret': naverClientSecret,
    };

    const [blogRes, kinRes] = await Promise.all([
      fetch(`https://openapi.naver.com/v1/search/blog.json?query=${blogQuery}&display=3&sort=sim`, { headers: naverHeaders }),
      fetch(`https://openapi.naver.com/v1/search/kin.json?query=${kinQuery}&display=2&sort=sim`,   { headers: naverHeaders }),
    ]);

    const [blogData, kinData] = await Promise.all([
      blogRes.json(),
      kinRes.json(),
    ]);

    // HTML 태그 및 특수문자 제거
    const stripHtml = str => str
      .replace(/<[^>]*>/g, '')
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .replace(/&#x27;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .trim();

    const blogItems = (blogData.items || []).map(item => ({
      title:   stripHtml(item.title),
      content: stripHtml(item.description),
      url:     item.link,
      type:    '블로그',
    }));

    const kinItems = (kinData.items || []).map(item => ({
      title:   stripHtml(item.title),
      content: stripHtml(item.description),
      url:     item.link,
      type:    '지식iN',
    }));

    // 지식iN을 앞에 배치 (더 신뢰도 높음)
    const allItems = [...kinItems, ...blogItems];

    if (allItems.length === 0) {
      return res.status(200).json({
        food:    q,
        status:  'unknown',
        summary: '관련 정보를 찾지 못했어요',
        detail:  '검색 결과가 없습니다. 담당 산부인과 의사에게 직접 문의하세요.',
        tips:    null,
        sources: [],
      });
    }

    // Step 2. Claude Haiku로 분석 (최저비용 모델)
    const searchContext = allItems
      .map((item, i) => `[${i + 1}] ${item.title}: ${item.content}`)
      .join('\n');

    const prompt = `임산부 영양 전문가로서 "${q}"의 임신 중 섭취 안전 여부를 아래 검색 결과 기반으로 분석하세요.

${searchContext}

JSON만 출력:
{"food":"${q}","status":"safe|caution|avoid|unknown","summary":"20자이내","detail":"3문장","tips":"1문장또는null"}`;

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         claudeApiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages:   [{ role: 'user', content: prompt }],
      }),
    });

    const claudeData = await claudeRes.json();
    console.log('Claude status:', claudeRes.status);

    if (!claudeRes.ok) {
      throw new Error(`Claude ${claudeRes.status}: ${claudeData.error?.message}`);
    }

    const rawText = claudeData.content?.map(b => b.text || '').join('').replace(/```json|```/g, '').trim();
    if (!rawText) throw new Error('Claude 응답이 비어있습니다');

    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (e) {
      throw new Error('JSON 파싱 실패: ' + rawText.slice(0, 200));
    }

    return res.status(200).json({
      ...parsed,
      sources: allItems.map(i => ({ title: i.title, link: i.url, type: i.type })),
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: '검색 중 오류가 발생했습니다: ' + err.message });
  }
}
