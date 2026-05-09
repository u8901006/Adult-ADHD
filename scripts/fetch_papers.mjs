import { writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, basename } from 'node:path';

const PUBMED_SEARCH = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi';
const PUBMED_FETCH = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi';
const HEADERS = { 'User-Agent': 'AdultADHDBot/1.0 (research aggregator)' };

const ADULT_ADHD_QUERY_CORE = [
  '"Attention Deficit Disorder with Hyperactivity"[Mesh]',
  'ADHD[tiab]',
  '"attention deficit hyperactivity disorder"[tiab]',
  '"attention-deficit/hyperactivity disorder"[tiab]',
  '"adult ADHD"[tiab]',
].join(' OR ');

const ADULT_FILTER = [
  'adult[MeSH Terms]',
  'adult*[tiab]',
  'adulthood[tiab]',
  '"young adult"[MeSH Terms]',
  '"middle aged"[MeSH Terms]',
  '"older adults"[tiab]',
].join(' OR ');

function buildQuery(days) {
  const since = new Date(Date.now() - days * 86400000);
  const sinceStr = `${since.getFullYear()}/${String(since.getMonth() + 1).padStart(2, '0')}/${String(since.getDate()).padStart(2, '0')}`;
  return `(${ADULT_ADHD_QUERY_CORE}) AND (${ADULT_FILTER}) AND "${sinceStr}"[Date - Publication] : "3000"[Date - Publication]`;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { days: 7, maxPapers: 60, output: 'papers.json' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--days' && args[i + 1]) opts.days = Math.max(1, parseInt(args[i + 1], 10) || 7);
    if (args[i] === '--max-papers' && args[i + 1]) opts.maxPapers = Math.max(1, parseInt(args[i + 1], 10) || 60);
    if (args[i] === '--output' && args[i + 1]) opts.output = args[i + 1];
  }
  return opts;
}

async function searchPapers(query, retmax) {
  const url = `${PUBMED_SEARCH}?db=pubmed&term=${encodeURIComponent(query)}&retmax=${retmax}&sort=date&retmode=json`;
  try {
    const resp = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(30000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    return data?.esearchresult?.idlist || [];
  } catch (e) {
    console.error(`[ERROR] PubMed search failed: ${e.message}`);
    return [];
  }
}

async function fetchDetails(pmids) {
  if (!pmids.length) return [];
  const ids = pmids.join(',');
  const url = `${PUBMED_FETCH}?db=pubmed&id=${encodeURIComponent(ids)}&retmode=xml`;
  try {
    const resp = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(60000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const xml = await resp.text();
    return parseXml(xml);
  } catch (e) {
    console.error(`[ERROR] PubMed fetch failed: ${e.message}`);
    return [];
  }
}

function parseXml(xml) {
  const papers = [];
  const articleRegex = /<PubmedArticle>([\s\S]*?)<\/PubmedArticle>/g;
  let match;
  while ((match = articleRegex.exec(xml)) !== null) {
    const block = match[1];

    const pmidMatch = block.match(/<PMID[^>]*>(\d+)<\/PMID>/);
    const pmid = pmidMatch ? pmidMatch[1] : '';

    const titleMatch = block.match(/<ArticleTitle>([\s\S]*?)<\/ArticleTitle>/);
    let title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : '';

    const abstractParts = [];
    const absRegex = /<AbstractText[^>]*Label="([^"]*)"[^>]*>([\s\S]*?)<\/AbstractText>/g;
    let absMatch;
    while ((absMatch = absRegex.exec(block)) !== null) {
      const text = absMatch[2].replace(/<[^>]+>/g, '').trim();
      if (text) abstractParts.push(`${absMatch[1]}: ${text}`);
    }
    const absNoLabel = block.match(/<AbstractText>([\s\S]*?)<\/AbstractText>/g);
    if (absNoLabel && abstractParts.length === 0) {
      for (const a of absNoLabel) {
        const t = a.replace(/<[^>]+>/g, '').trim();
        if (t) abstractParts.push(t);
      }
    }
    const abstract = abstractParts.join(' ').slice(0, 2000);

    const journalMatch = block.match(/<Title>([\s\S]*?)<\/Title>/);
    const journal = journalMatch ? journalMatch[1].trim() : '';

    const yearMatch = block.match(/<Year>(\d{4})<\/Year>/);
    const monthMatch = block.match(/<Month>([^<]+)<\/Month>/);
    const dayMatch = block.match(/<Day>(\d+)<\/Day>/);
    const dateParts = [yearMatch?.[1], monthMatch?.[1], dayMatch?.[1]].filter(Boolean);
    const dateStr = dateParts.join(' ');

    const url = pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : '';

    const keywords = [];
    const kwRegex = /<Keyword>([^<]+)<\/Keyword>/g;
    let kwMatch;
    while ((kwMatch = kwRegex.exec(block)) !== null) {
      if (kwMatch[1].trim()) keywords.push(kwMatch[1].trim());
    }

    if (title) {
      papers.push({ pmid, title, journal, date: dateStr, abstract, url, keywords });
    }
  }
  return papers;
}

function getExistingPmids() {
  const docsDir = resolve('docs');
  if (!existsSync(docsDir)) return new Set();
  const pmids = new Set();
  const files = readdirSync(docsDir).filter(f => f.startsWith('adult-adhd-') && f.endsWith('.html'));
  const sevenDaysAgo = Date.now() - 7 * 86400000;
  for (const f of files) {
    const dateStr = f.replace('adult-adhd-', '').replace('.html', '');
    const fileDate = new Date(dateStr);
    if (isNaN(fileDate.getTime()) || fileDate.getTime() < sevenDaysAgo) continue;
    try {
      const html = readFileSync(resolve(docsDir, f), 'utf-8');
      const re = /pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/g;
      let m;
      while ((m = re.exec(html)) !== null) {
        pmids.add(m[1]);
      }
    } catch {}
  }
  return pmids;
}

function getDateTaipei() {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  return new Date(utc + 8 * 3600000);
}

async function main() {
  const opts = parseArgs();
  console.error(`[INFO] Searching PubMed for adult ADHD papers (last ${opts.days} days)...`);

  const query = buildQuery(opts.days);
  const pmids = await searchPapers(query, opts.maxPapers);
  console.error(`[INFO] Found ${pmids.length} PMIDs`);

  if (!pmids.length) {
    const dateStr = getDateTaipei().toISOString().slice(0, 10);
    const output = { date: dateStr, count: 0, papers: [] };
    writeFileSync(opts.output, JSON.stringify(output, null, 2), 'utf-8');
    console.error('[INFO] No papers found');
    return;
  }

  const papers = await fetchDetails(pmids);
  console.error(`[INFO] Fetched details for ${papers.length} papers`);

  const existingPmids = getExistingPmids();
  const newPapers = papers.filter(p => !existingPmids.has(p.pmid));
  console.error(`[INFO] After dedup: ${newPapers.length} new papers (skipped ${papers.length - newPapers.length} already summarized)`);

  const dateStr = getDateTaipei().toISOString().slice(0, 10);
  const output = { date: dateStr, count: newPapers.length, papers: newPapers };
  writeFileSync(opts.output, JSON.stringify(output, null, 2), 'utf-8');
  console.error(`[INFO] Saved to ${opts.output}`);
}

main().catch(e => {
  console.error(`[FATAL] ${e.message}`);
  process.exit(1);
});
