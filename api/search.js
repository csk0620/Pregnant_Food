// Vercel Serverless Function
// API 키를 서버 측에서 안전하게 관리합니다
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'q 파라미터가 필요합니다' });

  const apiKey = process.env.GOOGLE_CSE_API_KEY;
  const cx    = process.env.GOOGLE_CSE_CX;

  if (!apiKey || !cx) {
    return res.status(500).json({ error: '서버 환경변수가 설정되지 않았습니다' });
  }

  try {
    const query = encodeURIComponent(`임산부 임신 중 ${q} 먹어도 되나요 안전`);
    const url = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${cx}&q=${query}&num=5&hl=ko&gl=kr`;

    const response = await fetch(url);
    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ error: data.error?.message || 'Google API 오류' });
    }

    // 검색 결과에서 임산부 안전 정보 추출
    const items = (data.items || []).map(item => ({
      title:   item.title,
      snippet: item.snippet,
      link:    item.link,
    }));

    // 스니펫 텍스트를 분석해 안전 여부 휴리스틱 판단
    const fullText = items.map(i => i.title + ' ' + i.snippet).join(' ').toLowerCase();

    const avoidKeywords   = ['피해야', '금지', '위험', '안돼', '안 돼', '먹으면 안', '절대', '금물', '유산', '조산'];
    const cautionKeywords = ['주의', '소량', '제한', '조심', '적당량', '과다섭취', '과량'];
    const safeKeywords    = ['안전', '괜찮', '먹어도', '섭취 가능', '좋은', '도움'];

    let heuristicStatus = 'unknown';
    const avoidScore   = avoidKeywords.filter(k => fullText.includes(k)).length;
    const cautionScore = cautionKeywords.filter(k => fullText.includes(k)).length;
    const safeScore    = safeKeywords.filter(k => fullText.includes(k)).length;

    if (avoidScore >= 2)                         heuristicStatus = 'avoid';
    else if (cautionScore >= 2 || avoidScore === 1) heuristicStatus = 'caution';
    else if (safeScore >= 2)                     heuristicStatus = 'safe';

    return res.status(200).json({
      query:           q,
      heuristicStatus,
      results:         items,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: '검색 중 오류가 발생했습니다' });
  }
}
