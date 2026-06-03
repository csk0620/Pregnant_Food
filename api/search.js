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
  const geminiApiKey      = process.env.GEMINI_API_KEY;

  if (!naverClientId || !naverClientSecret || !geminiApiKey) {
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
      fetch(`https://openapi.naver.com/v1/search/blog.json?query=${blogQuery}&display=5&sort=sim`, { headers: naverHeaders }),
      fetch(`https://openapi.naver.com/v1/search/kin.json?query=${kinQuery}&display=3&sort=sim`,   { headers: naverHeaders }),
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

    // Step 2. Gemini로 분석
    const searchContext = allItems
      .map((item, i) => `[${i + 1}][${item.type}] ${item.title}\n${item.content}`)
      .join('\n\n');

    const prompt = `당신은 임산부 영양 전문가입니다. 아래 한국 웹 검색 결과(블로그, 지식iN)를 바탕으로 "${q}"이(가) 임신 중 섭취해도 되는지 종합적으로 분석해 주세요.

[검색 결과]
${searchContext}

반드시 아래 JSON 형식으로만 응답하세요. 마크다운이나 다른 텍스트 없이 JSON만 출력하세요:
{
  "food": "음식 이름",
  "status": "safe" | "caution" | "avoid" | "unknown",
  "summary": "한 줄 요약 (25자 이내)",
  "detail": "상세 설명 (4~5문장. 임신 중 주의사항, 위험 요소, 영양 정보, 섭취 가능 여부 근거 포함. 여러 출처 내용을 종합)",
  "tips": "실용적인 팁, 조리법 또는 대체 식품 (2~3문장, 없으면 null)"
}

status 판단 기준:
- safe: 임신 중 안전하게 섭취 가능
- caution: 소량·조건부 섭취 가능하거나 주의가 필요한 경우
- avoid: 임신 중 피하는 것이 권장되는 경우
- unknown: 판단하기 어려운 경우

중요: 의학적으로 신뢰할 수 있는 정보를 우선하고, 상충되는 의견이 있으면 더 안전한 방향으로 판단하세요.`;

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-8b:generateContent?key=${geminiApiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 800 },
        }),
      }
    );

    const geminiData = await geminiRes.json();
    console.log('Gemini status:', geminiRes.status);
    console.log('Gemini response:', JSON.stringify(geminiData).slice(0, 500));

    if (!geminiRes.ok) {
      throw new Error(`Gemini ${geminiRes.status}: ${geminiData.error?.message || JSON.stringify(geminiData)}`);
    }

    const rawText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!rawText) throw new Error('Gemini 응답이 비어있습니다: ' + JSON.stringify(geminiData));

    const cleanText = rawText.replace(/```json|```/g, '').trim();
    let parsed;
    try {
      parsed = JSON.parse(cleanText);
    } catch (e) {
      throw new Error('JSON 파싱 실패: ' + cleanText.slice(0, 200));
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
