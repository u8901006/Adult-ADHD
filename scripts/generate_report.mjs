import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const API_BASE = process.env.ZHIPU_API_BASE || 'https://open.bigmodel.cn/api/coding/paas/v4';
const MODEL_CHAIN = ['glm-5-turbo', 'glm-5.1', 'glm-4.7', 'glm-4.7-flash', 'glm-4-plus', 'glm-4-flash', 'glm-4'];
const MAX_TOKENS = 50000;
const API_TIMEOUT_MS = 120000;
const MAX_RETRIES = 2;

const SYSTEM_PROMPT = `你是成人注意力不足過動症（adult ADHD）領域的資深研究員與科學傳播者。你的任務是：
1. 從提供的醫學文獻中，篩選出最具臨床意義與研究價值的成人 ADHD 論文
2. 對每篇論文進行繁體中文摘要、分類、PICO 分析
3. 評估其臨床實用性（高/中/低）
4. 生成適合醫療專業人員與 ADHD 關注者閱讀的日報

輸出格式要求：
- 語言：繁體中文（台灣用語）
- 專業但易懂
- 每篇論文需包含：中文標題、一句話總結、PICO分析、臨床實用性、分類標籤
- 最後提供今日精選 TOP Picks（最重要/最影響臨床實踐的論文）
回傳格式必須是純 JSON，不要用 markdown code block 包裹。`;

const TAG_OPTIONS = [
  '成人ADHD', '注意力不足過動症', '診斷評估', '藥物治療', '刺激素類藥物',
  '非刺激素藥物', 'CBT認知行為治療', '心理治療', '執行功能', '情緒調節',
  '神經影像學', '神經科學', '共病症', '憂鬱症', '焦慮症', '物質使用',
  '自閉症共病', '睡眠障礙', '女性ADHD', '孕期用藥', '老年ADHD',
  '職場功能', '學業表現', '駕駛安全', '公共衛生', '流行病學',
  '數位健康', 'APP介入', '神經回饋', '社會功能', '生活品質',
  '篩檢工具', 'ASRS', 'DIVA-5', 'CAARS', '系統性回顧', '統合分析',
  '隨機對照試驗', '縱貫性研究', '台灣/亞洲研究', '藥物安全', '成癮與衝動',
];

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { input: '', output: '', apiKey: process.env.ZHIPU_API_KEY || '' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input' && args[i + 1]) opts.input = args[i + 1];
    if (args[i] === '--output' && args[i + 1]) opts.output = args[i + 1];
    if (args[i] === '--api-key' && args[i + 1]) opts.apiKey = args[i + 1];
  }
  return opts;
}

function loadPapers(path) {
  const raw = readFileSync(resolve(path), 'utf-8');
  return JSON.parse(raw);
}

function sanitizeStr(str) {
  return String(str || '').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function extractJson(text) {
  if (!text) return null;
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    const firstNewline = cleaned.indexOf('\n');
    cleaned = firstNewline >= 0 ? cleaned.slice(firstNewline + 1) : cleaned.slice(3);
    cleaned = cleaned.replace(/```+\s*$/, '');
  }
  cleaned = cleaned.trim();

  try {
    return JSON.parse(cleaned);
  } catch {}

  const jsonStart = cleaned.indexOf('{');
  const jsonEnd = cleaned.lastIndexOf('}');
  if (jsonStart >= 0 && jsonEnd > jsonStart) {
    const candidate = cleaned.slice(jsonStart, jsonEnd + 1);
    try {
      return JSON.parse(candidate);
    } catch {}

    const fixed = candidate
      .replace(/,\s*([}\]])/g, '$1')
      .replace(/"\s*\n\s*"/g, '",\n"')
      .replace(/\\(?!["\\/bfnrtu])/g, '\\\\')
      .replace(/\t/g, '  ');
    try {
      return JSON.parse(fixed);
    } catch {}
  }

  return null;
}

async function callZhipuAPI(apiKey, payload, timeout) {
  const resp = await fetch(`${API_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeout),
  });
  return resp;
}

async function analyzePapers(apiKey, papersData) {
  const dateStr = papersData.date || new Date().toISOString().slice(0, 10);
  const paperCount = papersData.count || 0;
  const papersText = JSON.stringify(papersData.papers || [], null, 2);

  const prompt = `以下是 ${dateStr} 從 PubMed 抓取的最新成人 ADHD 文獻（共 ${paperCount} 篇）。

請進行以下分析，並以 JSON 格式回傳（不要用 markdown code block）：

{
  "date": "${dateStr}",
  "market_summary": "1-2句話總結今天文獻的整體趨勢與亮點，聚焦成人ADHD",
  "top_picks": [
    {
      "rank": 1,
      "title_zh": "中文標題",
      "title_en": "English Title",
      "journal": "期刊名",
      "summary": "一句話總結（繁體中文，點出核心發現與臨床意義）",
      "pico": {
        "population": "研究對象",
        "intervention": "介入措施",
        "comparison": "對照組",
        "outcome": "主要結果"
      },
      "clinical_utility": "高/中/低",
      "utility_reason": "為什麼實用的一句話說明",
      "tags": ["標籤1", "標籤2"],
      "url": "原文連結",
      "emoji": "相關emoji"
    }
  ],
  "all_papers": [
    {
      "title_zh": "中文標題",
      "title_en": "English Title",
      "journal": "期刊名",
      "summary": "一句話總結",
      "clinical_utility": "高/中/低",
      "tags": ["標籤1"],
      "url": "連結",
      "emoji": "emoji"
    }
  ],
  "keywords": ["關鍵字1", "關鍵字2"],
  "topic_distribution": {
    "成人ADHD": 3,
    "藥物治療": 2
  }
}

原始文獻資料：
${papersText}

請篩選出最重要的 TOP 5-8 篇論文放入 top_picks（按重要性排序），其餘放入 all_papers。
每篇 paper 的 tags 請從以下選擇：${TAG_OPTIONS.join('、')}
記住：回傳純 JSON，不要用 \`\`\`json\`\`\` 包裹。`;

  for (const model of MODEL_CHAIN) {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        console.error(`[INFO] Trying ${model} (attempt ${attempt + 1})...`);
        const payload = {
          model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: prompt },
          ],
          temperature: 0.3,
          top_p: 0.9,
          max_tokens: MAX_TOKENS,
        };

        const resp = await callZhipuAPI(apiKey, payload, API_TIMEOUT_MS);

        if (resp.status === 429) {
          const wait = 60 * (attempt + 1);
          console.error(`[WARN] Rate limited, waiting ${wait}s...`);
          await new Promise(r => setTimeout(r, wait * 1000));
          continue;
        }

        if (!resp.ok) {
          const errText = await resp.text().catch(() => '');
          console.error(`[ERROR] HTTP ${resp.status}: ${errText.slice(0, 300)}`);
          if (resp.status >= 500 && attempt < MAX_RETRIES - 1) {
            await new Promise(r => setTimeout(r, 10000));
            continue;
          }
          break;
        }

        const data = await resp.json();
        const rawContent = data?.choices?.[0]?.message?.content;
        if (!rawContent) {
          console.error(`[WARN] Empty response from ${model}`);
          break;
        }

        const result = extractJson(rawContent);
        if (!result) {
          console.error(`[WARN] JSON parse failed for ${model}, attempt ${attempt + 1}`);
          if (attempt < MAX_RETRIES - 1) {
            await new Promise(r => setTimeout(r, 5000));
            continue;
          }
          break;
        }

        console.error(`[INFO] Analysis complete: ${(result.top_picks || []).length} top picks, ${(result.all_papers || []).length} total`);
        result._model = model;
        return result;
      } catch (e) {
        if (e.name === 'TimeoutError' || e.name === 'AbortError') {
          console.error(`[WARN] ${model} timed out after ${API_TIMEOUT_MS}ms`);
        } else {
          console.error(`[ERROR] ${model} failed: ${e.message}`);
        }
        if (attempt < MAX_RETRIES - 1) {
          await new Promise(r => setTimeout(r, 5000));
        }
      }
    }
  }

  console.error('[ERROR] All models and attempts failed');
  return null;
}

function generateHTML(analysis) {
  const dateStr = analysis.date || new Date().toISOString().slice(0, 10);
  const dp = dateStr.split('-');
  const dateDisplay = dp.length === 3 ? `${dp[0]}年${parseInt(dp[1])}月${parseInt(dp[2])}日` : dateStr;
  const summary = sanitizeStr(analysis.market_summary || '');
  const topPicks = analysis.top_picks || [];
  const allPapers = analysis.all_papers || [];
  const keywords = analysis.keywords || [];
  const topicDist = analysis.topic_distribution || {};
  const totalCount = topPicks.length + allPapers.length;
  const usedModel = analysis._model || MODEL_CHAIN[0];

  const topPicksHTML = topPicks.map(pick => {
    const tags = (pick.tags || []).map(t => `<span class="tag">${sanitizeStr(t)}</span>`).join('');
    const util = String(pick.clinical_utility || '中');
    const uc = util === '高' ? 'utility-high' : util === '中' ? 'utility-mid' : 'utility-low';
    const pico = pick.pico || {};
    const picoHTML = Object.keys(pico).length ? `
      <div class="pico-grid">
        <div class="pico-item"><span class="pico-label">P</span><span class="pico-text">${sanitizeStr(pico.population)}</span></div>
        <div class="pico-item"><span class="pico-label">I</span><span class="pico-text">${sanitizeStr(pico.intervention)}</span></div>
        <div class="pico-item"><span class="pico-label">C</span><span class="pico-text">${sanitizeStr(pico.comparison)}</span></div>
        <div class="pico-item"><span class="pico-label">O</span><span class="pico-text">${sanitizeStr(pico.outcome)}</span></div>
      </div>` : '';

    return `
    <div class="news-card featured">
      <div class="card-header">
        <span class="rank-badge">#${sanitizeStr(pick.rank)}</span>
        <span class="emoji-icon">${sanitizeStr(pick.emoji || '📄')}</span>
        <span class="${uc}">${sanitizeStr(util)}實用性</span>
      </div>
      <h3>${sanitizeStr(pick.title_zh || pick.title_en)}</h3>
      <p class="journal-source">${sanitizeStr(pick.journal)} &middot; ${sanitizeStr(pick.title_en)}</p>
      <p>${sanitizeStr(pick.summary)}</p>
      ${picoHTML}
      ${pick.utility_reason ? `<p class="utility-reason">💡 ${sanitizeStr(pick.utility_reason)}</p>` : ''}
      <div class="card-footer">
        ${tags}
        <a href="${sanitizeStr(pick.url || '#')}" target="_blank" rel="noopener">閱讀原文 →</a>
      </div>
    </div>`;
  }).join('');

  const allPapersHTML = allPapers.map(paper => {
    const tags = (paper.tags || []).map(t => `<span class="tag">${sanitizeStr(t)}</span>`).join('');
    const util = String(paper.clinical_utility || '中');
    const uc = util === '高' ? 'utility-high' : util === '中' ? 'utility-mid' : 'utility-low';
    return `
    <div class="news-card">
      <div class="card-header-row">
        <span class="emoji-sm">${sanitizeStr(paper.emoji || '📄')}</span>
        <span class="${uc} utility-sm">${sanitizeStr(util)}</span>
      </div>
      <h3>${sanitizeStr(paper.title_zh || paper.title_en)}</h3>
      <p class="journal-source">${sanitizeStr(paper.journal)}</p>
      <p>${sanitizeStr(paper.summary)}</p>
      <div class="card-footer">
        ${tags}
        <a href="${sanitizeStr(paper.url || '#')}" target="_blank" rel="noopener">PubMed →</a>
      </div>
    </div>`;
  }).join('');

  const keywordsHTML = keywords.map(k => `<span class="keyword">${sanitizeStr(k)}</span>`).join('');

  let topicBarsHTML = '';
  if (Object.keys(topicDist).length) {
    const maxCount = Math.max(...Object.values(topicDist), 1);
    topicBarsHTML = Object.entries(topicDist).map(([topic, count]) => {
      const w = Math.round((count / maxCount) * 100);
      return `
      <div class="topic-row">
        <span class="topic-name">${sanitizeStr(topic)}</span>
        <div class="topic-bar-bg"><div class="topic-bar" style="width:${w}%"></div></div>
        <span class="topic-count">${count}</span>
      </div>`;
    }).join('');
  }

  const weekDays = ['日', '一', '二', '三', '四', '五', '六'];
  const dateObj = new Date(dateStr);
  const weekDay = weekDays[dateObj.getDay()] || '';

  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Adult ADHD Daily &middot; 成人 ADHD 文獻日報 &middot; ${dateDisplay}</title>
<meta name="description" content="${dateDisplay} 成人注意力不足過動症文獻日報，由 AI 自動彙整 PubMed 最新論文"/>
<style>
:root{--bg:#f6f1e8;--surface:#fffaf2;--line:#d8c5ab;--text:#2b2118;--muted:#766453;--accent:#8c4f2b;--accent-soft:#ead2bf;--card-bg:color-mix(in srgb,var(--surface) 92%,white)}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{background:radial-gradient(circle at top,#fff6ea 0,var(--bg) 55%,#ead8c6 100%);color:var(--text);font-family:"Noto Sans TC","PingFang TC","Helvetica Neue",Arial,sans-serif;min-height:100vh;overflow-x:hidden}
.container{position:relative;z-index:1;max-width:880px;margin:0 auto;padding:60px 32px 80px}
header{display:flex;align-items:center;gap:16px;margin-bottom:52px;animation:fadeDown .6s ease both}
.logo{width:48px;height:48px;border-radius:14px;background:var(--accent);display:flex;align-items:center;justify-content:center;font-size:22px;flex-shrink:0;box-shadow:0 4px 20px rgba(140,79,43,.25)}
.header-text h1{font-size:22px;font-weight:700;color:var(--text);letter-spacing:-.3px}
.header-meta{display:flex;gap:8px;margin-top:6px;flex-wrap:wrap;align-items:center}
.badge{display:inline-block;padding:3px 10px;border-radius:20px;font-size:11px;letter-spacing:.3px}
.badge-date{background:var(--accent-soft);border:1px solid var(--line);color:var(--accent)}
.badge-count{background:rgba(140,79,43,.06);border:1px solid var(--line);color:var(--muted)}
.badge-source{background:transparent;color:var(--muted);font-size:11px;padding:0 4px}
.summary-card{background:var(--card-bg);border:1px solid var(--line);border-radius:24px;padding:28px 32px;margin-bottom:32px;box-shadow:0 20px 60px rgba(61,36,15,.06);animation:fadeUp .5s ease .1s both}
.summary-card h2{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1.6px;color:var(--accent);margin-bottom:16px}
.summary-text{font-size:15px;line-height:1.8;color:var(--text)}
.section{margin-bottom:36px;animation:fadeUp .5s ease both}
.section-title{display:flex;align-items:center;gap:10px;font-size:17px;font-weight:700;color:var(--text);margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid var(--line)}
.section-icon{width:28px;height:28px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0;background:var(--accent-soft)}
.news-card{background:var(--card-bg);border:1px solid var(--line);border-radius:24px;padding:22px 26px;margin-bottom:12px;box-shadow:0 8px 30px rgba(61,36,15,.04);transition:background .2s,border-color .2s,transform .2s}
.news-card:hover{transform:translateY(-2px);box-shadow:0 12px 40px rgba(61,36,15,.08)}
.news-card.featured{border-left:3px solid var(--accent)}
.news-card.featured:hover{border-color:var(--accent)}
.card-header{display:flex;align-items:center;gap:8px;margin-bottom:10px}
.rank-badge{background:var(--accent);color:#fff7f0;font-weight:700;font-size:12px;padding:2px 8px;border-radius:6px}
.emoji-icon{font-size:18px}
.card-header-row{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.emoji-sm{font-size:14px}
.news-card h3{font-size:15px;font-weight:600;color:var(--text);margin-bottom:8px;line-height:1.5}
.journal-source{font-size:12px;color:var(--accent);margin-bottom:8px;opacity:.8}
.news-card p{font-size:13.5px;line-height:1.75;color:var(--muted)}
.utility-reason{font-size:12px!important;color:var(--accent)!important;opacity:.85;margin-top:4px}
.card-footer{margin-top:12px;display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.tag{padding:2px 9px;background:var(--accent-soft);border-radius:999px;font-size:11px;color:var(--accent)}
.news-card a{font-size:12px;color:var(--accent);text-decoration:none;opacity:.7;margin-left:auto}
.news-card a:hover{opacity:1}
.utility-high{color:#5a7a3a;font-size:11px;font-weight:600;padding:2px 8px;background:rgba(90,122,58,.1);border-radius:4px}
.utility-mid{color:#9f7a2e;font-size:11px;font-weight:600;padding:2px 8px;background:rgba(159,122,46,.1);border-radius:4px}
.utility-low{color:var(--muted);font-size:11px;font-weight:600;padding:2px 8px;background:rgba(118,100,83,.08);border-radius:4px}
.utility-sm{font-size:10px}
.pico-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px;padding:12px;background:rgba(255,253,249,.8);border-radius:14px;border:1px solid var(--line)}
.pico-item{display:flex;gap:8px;align-items:baseline}
.pico-label{font-size:10px;font-weight:700;color:#fff7f0;background:var(--accent);padding:2px 6px;border-radius:4px;flex-shrink:0}
.pico-text{font-size:12px;color:var(--muted);line-height:1.4}
.keywords-section{margin-bottom:36px}
.keywords{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}
.keyword{padding:5px 14px;background:var(--accent-soft);border:1px solid var(--line);border-radius:20px;font-size:12px;color:var(--accent);cursor:default;transition:background .2s}
.keyword:hover{background:rgba(140,79,43,.18)}
.topic-section{margin-bottom:36px}
.topic-row{display:flex;align-items:center;gap:10px;margin-bottom:8px}
.topic-name{font-size:13px;color:var(--muted);width:120px;flex-shrink:0;text-align:right}
.topic-bar-bg{flex:1;height:8px;background:var(--line);border-radius:4px;overflow:hidden}
.topic-bar{height:100%;background:linear-gradient(90deg,var(--accent),#c47a4a);border-radius:4px;transition:width .6s ease}
.topic-count{font-size:12px;color:var(--accent);width:24px}
.links-section{margin-top:48px;display:flex;flex-direction:column;gap:12px;animation:fadeUp .5s ease .4s both}
.link-card{display:flex;align-items:center;gap:14px;padding:18px 24px;background:var(--card-bg);border:1px solid var(--line);border-radius:24px;text-decoration:none;color:var(--text);transition:all .2s;box-shadow:0 8px 30px rgba(61,36,15,.04)}
.link-card:hover{border-color:var(--accent);transform:translateY(-2px);box-shadow:0 12px 40px rgba(61,36,15,.08)}
.link-icon{font-size:28px;flex-shrink:0}
.link-name{font-size:15px;font-weight:700;color:var(--text);flex:1}
.link-desc{font-size:12px;color:var(--muted);margin-top:2px}
.link-arrow{font-size:18px;color:var(--accent);font-weight:700}
footer{margin-top:32px;padding-top:22px;border-top:1px solid var(--line);font-size:11.5px;color:var(--muted);display:flex;justify-content:space-between;animation:fadeUp .5s ease .5s both}
footer a{color:var(--muted);text-decoration:none}
footer a:hover{color:var(--accent)}
@keyframes fadeDown{from{opacity:0;transform:translateY(-16px)}to{opacity:1;transform:translateY(0)}}
@keyframes fadeUp{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}
@media(max-width:600px){.container{padding:36px 18px 60px}.summary-card,.news-card{padding:20px 18px}.pico-grid{grid-template-columns:1fr}footer{flex-direction:column;gap:6px;text-align:center}.topic-name{width:80px;font-size:11px}.links-section{gap:10px}.link-card{padding:14px 18px}}
</style>
</head>
<body>
<div class="container">
  <header>
    <div class="logo">🧠</div>
    <div class="header-text">
      <h1>Adult ADHD Daily &middot; 成人 ADHD 文獻日報</h1>
      <div class="header-meta">
        <span class="badge badge-date">📅 ${dateDisplay}（週${weekDay}）</span>
        <span class="badge badge-count">📊 ${totalCount} 篇文獻</span>
        <span class="badge badge-source">Powered by PubMed + Zhipu AI</span>
      </div>
    </div>
  </header>

  <div class="summary-card">
    <h2>📋 今日文獻趨勢</h2>
    <p class="summary-text">${summary}</p>
  </div>

  ${topPicksHTML ? `<div class="section"><div class="section-title"><span class="section-icon">⭐</span>今日精選 TOP Picks</div>${topPicksHTML}</div>` : ''}

  ${allPapersHTML ? `<div class="section"><div class="section-title"><span class="section-icon">📚</span>其他值得關注的文獻</div>${allPapersHTML}</div>` : ''}

  ${topicBarsHTML ? `<div class="topic-section section"><div class="section-title"><span class="section-icon">📊</span>主題分佈</div>${topicBarsHTML}</div>` : ''}

  ${keywordsHTML ? `<div class="keywords-section section"><div class="section-title"><span class="section-icon">🏷️</span>關鍵字</div><div class="keywords">${keywordsHTML}</div></div>` : ''}

  <div class="links-section">
    <a href="https://www.leepsyclinic.com/" class="link-card" target="_blank" rel="noopener">
      <span class="link-icon">🏥</span>
      <div><span class="link-name">李政洋身心診所</span><span class="link-desc">專業身心科診所，提供成人 ADHD 評估與治療</span></div>
      <span class="link-arrow">→</span>
    </a>
    <a href="https://blog.leepsyclinic.com/" class="link-card" target="_blank" rel="noopener">
      <span class="link-icon">📬</span>
      <div><span class="link-name">訂閱電子報</span><span class="link-desc">定期收到最新身心健康資訊與研究整理</span></div>
      <span class="link-arrow">→</span>
    </a>
    <a href="https://buymeacoffee.com/CYlee" class="link-card" target="_blank" rel="noopener">
      <span class="link-icon">☕</span>
      <div><span class="link-name">Buy Me a Coffee</span><span class="link-desc">支持本研究日報持續運作</span></div>
      <span class="link-arrow">→</span>
    </a>
  </div>

  <footer>
    <span>資料來源：PubMed &middot; 分析模型：${sanitizeStr(usedModel)}</span>
    <span><a href="https://github.com/u8901006/Adult-ADHD">GitHub</a></span>
  </footer>
</div>
</body>
</html>`;
}

async function main() {
  const opts = parseArgs();
  if (!opts.apiKey) {
    console.error('[ERROR] No API key. Set ZHIPU_API_KEY env var or use --api-key');
    process.exit(1);
  }
  if (!opts.input || !opts.output) {
    console.error('[ERROR] --input and --output are required');
    process.exit(1);
  }

  const papersData = loadPapers(opts.input);
  let analysis;

  if (!papersData?.papers?.length) {
    console.error('[WARN] No papers found, generating empty report');
    const today = new Date().toISOString().slice(0, 10);
    analysis = {
      date: today,
      market_summary: '今日 PubMed 暫無新的成人 ADHD 文獻更新。請明天再查看。',
      top_picks: [],
      all_papers: [],
      keywords: [],
      topic_distribution: {},
    };
  } else {
    analysis = await analyzePapers(opts.apiKey, papersData);
    if (!analysis) {
      console.error('[ERROR] Analysis failed, cannot generate report');
      process.exit(1);
    }
  }

  analysis._model = analysis._model || MODEL_CHAIN[0];
  const html = generateHTML(analysis);
  mkdirSync(dirname(resolve(opts.output)), { recursive: true });
  writeFileSync(resolve(opts.output), html, 'utf-8');
  console.error(`[INFO] Report saved to ${opts.output}`);
}

main().catch(e => {
  console.error(`[FATAL] ${e.message}`);
  process.exit(1);
});
