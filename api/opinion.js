/**
 * AI 종목 의견 (Vercel 서버리스 함수)
 * ------------------------------------------------
 * 요청 형식: GET /api/opinion?name=<종목명>
 *
 * 하는 일:
 * 1) 구글 뉴스 RSS에서 그 종목 관련 최근 헤드라인을 가져옴
 *    (일반 검색어 + "실적/전망" 검색어 두 가지로 나눠서 검색 →
 *    향후 실적 전망 관련 뉴스가 더 잘 섞여 들어오게 함)
 * 2) Claude API에게 업종/이슈 요약 + 향후 1~2년 전망을 시킴
 * 3) 요약 + 헤드라인을 JSON으로 반환
 *
 * Claude API 키는 Vercel 프로젝트의 환경변수(ANTHROPIC_API_KEY)에만
 * 저장되고, 브라우저에는 절대 노출되지 않음.
 *
 * [배경] 원래 Cloudflare Worker로 이 기능을 만들었는데, Anthropic API가
 * Cloudflare Worker의 발신 IP 대역을 차단하는 것으로 보이는 문제
 * (403 forbidden, "Request not allowed")가 있어서 Vercel로 옮김.
 * 네이버 금융 프록시(시총/재무/이동평균)는 Cloudflare Worker에서
 * 문제없이 잘 작동해서 그대로 둠 — 이 기능만 별도로 분리.
 */

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const name = req.query.name;
  if (!name) {
    res.status(400).json({ error: 'name 파라미터가 필요합니다. 예: ?name=삼성전자' });
    return;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    res.status(500).json({ error: '서버(Vercel)에 ANTHROPIC_API_KEY 환경변수가 설정되어 있지 않습니다.' });
    return;
  }

  // 1. 구글 뉴스 RSS에서 관련 헤드라인 가져오기 (실패해도 계속 진행)
  //    세 갈래로 나눠서 검색:
  //    - 컨센서스 검색어: 매출액/영업이익/순이익 숫자가 실제로 언급될 확률이 가장 높음
  //    - 실적/전망 검색어: 향후 방향성 관련
  //    - 일반 검색어: 종목 전반적인 최신 뉴스
  let headlines = [];
  let consensusHeadlines = [];
  try {
    const [consensusXml, outlookXml, generalXml] = await Promise.all([
      fetchRssXml(`${name} 컨센서스`),
      fetchRssXml(`${name} 실적 전망`),
      fetchRssXml(`${name} 주가`),
    ]);

    const consensusItems = consensusXml ? parseRssItems(consensusXml) : [];
    const outlookItems = outlookXml ? parseRssItems(outlookXml) : [];
    const generalItems = generalXml ? parseRssItems(generalXml) : [];

    consensusHeadlines = consensusItems.slice(0, 5);

    // 화면에 보여줄 뉴스 목록은 세 검색 결과를 합치되, 같은 제목은 중복 제거.
    // 컨센서스/전망 관련 헤드라인을 앞쪽에 배치해서 AI 요약에도 더 잘 반영되게 함.
    const seenTitles = new Set();
    const merged = [];
    for (const item of [...consensusItems, ...outlookItems, ...generalItems]) {
      if (!seenTitles.has(item.title)) {
        seenTitles.add(item.title);
        merged.push(item);
      }
    }
    headlines = merged.slice(0, 8);
  } catch (e) {
    // 뉴스 조회 실패해도 AI 요약은 시도함 (헤드라인 없이)
  }

  const headlineText = headlines.length
    ? headlines.map((h) => `- ${h.title}`).join('\n')
    : '(관련 뉴스를 찾지 못했습니다)';
  const consensusHeadlineText = consensusHeadlines.length
    ? consensusHeadlines.map((h) => `- ${h.title}`).join('\n')
    : '(컨센서스 관련 뉴스를 찾지 못했습니다)';

  const currentYear = new Date().getFullYear();
  const nextYear = currentYear + 1;
  const yearAfterNext = currentYear + 2;

  const systemPrompt =
    '당신은 주식 섹터/업종 전망을 간단히 설명하는 애널리스트입니다. ' +
    '주어진 종목명과 최근 뉴스 헤드라인을 참고해서, 이 회사가 속한 업종이 ' +
    `구조적으로 성장하는 업종인지, 그리고 뉴스에 언급된 ${nextYear}~${yearAfterNext}년 ` +
    '실적/업황 전망이 어떤 방향인지를 함께 반영한 한국어 요약을 4~5문장으로 ' +
    '작성하세요. 뉴스 헤드라인에 구체적인 수치(매출액, 목표주가 등)가 나오면 ' +
    '그대로 인용해도 되지만, 헤드라인에 없는 수치를 추정해서 지어내지 마세요. ' +
    '확정적인 투자 판단(사라/팔아라)은 하지 마세요. ' +
    '반드시 아래 JSON 형식으로만 답변하세요. 다른 텍스트는 포함하지 마세요.\n' +
    '{"summary": "4~5문장 한국어 요약"}';
  const userPrompt =
    `종목명: ${name}\n\n` +
    `컨센서스 관련 헤드라인:\n${consensusHeadlineText}\n\n` +
    `전체 최근 헤드라인:\n${headlineText}`;

  // 2. Claude API 호출 (비용 절감을 위해 Haiku 사용 — 단순 요약 작업)
  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 450,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    if (!claudeRes.ok) {
      const errText = await claudeRes.text();
      res.status(502).json({ error: `Claude API 호출 실패 (HTTP ${claudeRes.status}): ${errText}` });
      return;
    }

    const claudeData = await claudeRes.json();
    const rawText = (claudeData.content || [])
      .map((b) => b.text || '')
      .join('')
      .trim();
    const cleaned = rawText.replace(/```json|```/g, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      parsed = { summary: rawText || '요약 생성에 실패했습니다.' };
    }

    res.status(200).json({ summary: parsed.summary, headlines });
  } catch (e) {
    res.status(502).json({ error: 'Claude API 호출 중 오류: ' + String(e) });
  }
};

async function fetchRssXml(query) {
  try {
    const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=ko&gl=KR&ceid=KR:ko`;
    const rssRes = await fetch(rssUrl, {
      headers: {
        'User-Agent': (
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
        ),
      },
    });
    if (!rssRes.ok) return null;
    return await rssRes.text();
  } catch (e) {
    return null;
  }
}

function parseRssItems(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const titleMatch = block.match(/<title>([\s\S]*?)<\/title>/);
    const linkMatch = block.match(/<link>([\s\S]*?)<\/link>/);
    if (titleMatch) {
      items.push({
        title: decodeXmlEntities(titleMatch[1].replace(/^<!\[CDATA\[|\]\]>$/g, '')),
        link: linkMatch ? linkMatch[1].trim() : null,
      });
    }
  }
  return items;
}

function decodeXmlEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
