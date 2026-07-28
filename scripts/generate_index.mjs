import { readdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, basename } from 'node:path';

const docsDir = resolve('docs');
const weekDays = ['日', '一', '二', '三', '四', '五', '六'];

function main() {
  if (!existsSync(docsDir)) {
    writeFileSync(resolve(docsDir, 'index.html'), buildHTML([], 0), 'utf-8');
    return;
  }

  const files = readdirSync(docsDir)
    .filter(f => f.startsWith('adult-adhd-') && f.endsWith('.html'))
    .sort()
    .reverse();

  const total = files.length;
  const recent = files.slice(0, 30);

  const links = recent.map(f => {
    const dateStr = f.replace('adult-adhd-', '').replace('.html', '');
    let dateDisplay = dateStr;
    let weekday = '';
    try {
      const d = new Date(dateStr);
      if (!isNaN(d.getTime())) {
        dateDisplay = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
        weekday = `（週${weekDays[d.getDay()]}）`;
      }
    } catch {}
    return `<li><a href="${f}">📰 ${dateDisplay}${weekday}</a></li>`;
  }).join('\n');

  const html = buildHTML(links, total);
  writeFileSync(resolve(docsDir, 'index.html'), html, 'utf-8');
  console.error(`[INFO] Index page generated (${total} reports)`);
}

function buildHTML(links, total) {
  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Adult ADHD Daily ─ 成人 ADHD 文獻自動日報</title>
<style>
:root{--bg:#f6f1e8;--surface:#fffaf2;--line:#d8c5ab;--text:#2b2118;--muted:#766453;--accent:#8c4f2b;--accent-soft:#ead2bf}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{background:radial-gradient(circle at top,#fff6ea 0,var(--bg) 55%,#ead8c6 100%);color:var(--text);font-family:"Noto Sans TC","PingFang TC","Helvetica Neue",Arial,sans-serif;min-height:100vh}
.container{position:relative;z-index:1;max-width:640px;margin:0 auto;padding:80px 24px}
.logo{font-size:48px;text-align:center;margin-bottom:16px}
h1{text-align:center;font-size:24px;color:var(--text);margin-bottom:8px}
.subtitle{text-align:center;color:var(--accent);font-size:14px;margin-bottom:8px}
.description{text-align:center;color:var(--muted);font-size:13px;margin-bottom:48px;line-height:1.6}
.count{text-align:center;color:var(--muted);font-size:13px;margin-bottom:32px}
ul{list-style:none}
li{margin-bottom:8px}
a{color:var(--text);text-decoration:none;display:block;padding:14px 20px;background:var(--surface);border:1px solid var(--line);border-radius:12px;transition:all .2s;font-size:15px}
a:hover{background:var(--accent-soft);border-color:var(--accent);transform:translateX(4px)}
.links-row{display:flex;gap:12px;justify-content:center;margin-top:48px;flex-wrap:wrap}
.links-row a{display:inline-flex;align-items:center;gap:6px;padding:10px 18px;font-size:13px;background:var(--accent-soft);border-radius:20px;border:1px solid var(--line)}
.links-row a:hover{background:rgba(140,79,43,.18)}
footer{margin-top:56px;text-align:center;font-size:12px;color:var(--muted)}
footer a{display:inline;padding:0;background:none;border:none;color:var(--muted)}
footer a:hover{color:var(--accent)}
</style>
</head>
<body>
<div class="container">
  <div class="logo">🧠</div>
  <h1>Adult ADHD Daily</h1>
  <p class="subtitle">成人注意力不足過動症文獻自動日報 ─ 每日自動更新</p>
  <p class="description">由 AI 自動搜尋 PubMed 最新成人 ADHD 文獻，進行摘要、分類與臨床實用性評估</p>
  <p class="count">共 ${total} 份報告</p>
  <ul>${links}</ul>
  <div class="links-row">
    <a href="https://www.leepsyclinic.com/" target="_blank" rel="noopener">🏥 李政洋身心診所</a>
    <a href="https://blog.leepsyclinic.com/" target="_blank" rel="noopener">📬 訂閱電子報</a>
    <a href="https://buymeacoffee.com/CYlee" target="_blank" rel="noopener">☕ Buy Me a Coffee</a>
  </div>
  <footer>
    <p>Powered by PubMed + NVIDIA AI ─ <a href="https://github.com/u8901006/Adult-ADHD">GitHub</a></p>
  </footer>
</div>
</body>
</html>`;
}

main();
