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
    // Step 1. 네이버 블로그 + 지식iN + 뉴스 병렬 검색 (더 넓게)
    const blogQuery = encodeURIComponent(`임산부 ${q} 먹어도 되나요`);
    const kinQuery  = encodeURIComponent(`임산부 ${q}`);
    const newsQuery = encodeURIComponent(`임신 ${q} 섭취`);
    const naverHeaders = {
      'X-Naver-Client-Id':     naverClientId,
      'X-Naver-Client-Secret': naverClientSecret,
    };

    const [blogRes, kinRes, newsRes] = await Promise.all([
      fetch(`https://openapi.naver.com/v1/search/blog.json?query=${blogQuery}&display=7&sort=sim`, { headers: naverHeaders }),
      fetch(`https://openapi.naver.com/v1/search/kin.json?query=${kinQuery}&display=5&sort=sim`,   { headers: naverHeaders }),
      fetch(`https://openapi.naver.com/v1/search/news.json?query=${newsQuery}&display=3&sort=sim`, { headers: naverHeaders }),
    ]);

    const [blogData, kinData, newsData] = await Promise.all([
      blogRes.json(),
      kinRes.json(),
      newsRes.json(),
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

    const newsItems = (newsData.items || []).map(item => ({
      title:   stripHtml(item.title),
      content: stripHtml(item.description),
      url:     item.originallink || item.link,
      type:    '뉴스',
    }));

    // 신뢰도 순: 지식iN > 뉴스 > 블로그
    const allItems = [...kinItems, ...newsItems, ...blogItems];

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
    // 상위 8개만 전달해서 토큰 절약
    const topItems = allItems.slice(0, 8);
    const searchContext = topItems
      .map((item, i) => `[${i + 1}][${item.type}] ${item.title}: ${item.content}`)
      .join('\n');

    const prompt = `임산부 영양 전문가로서 "${q}"의 임신 중 섭취 안전 여부를 아래 검색 결과 기반으로 분석하세요.

${searchContext}

JSON만 출력(다른 텍스트 없이):
{"food":"${q}","status":"safe또는caution또는avoid또는unknown","summary":"25자이내한줄요약","detail":"임신중주의사항과근거포함3~4문장","tips":"실용적팁1~2문장또는null"}`;

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         claudeApiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 400,
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
      sources: topItems.map(i => ({ title: i.title, link: i.url, type: i.type })),
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: '검색 중 오류가 발생했습니다: ' + err.message });
  }
}
