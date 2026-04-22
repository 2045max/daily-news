import 'dotenv/config'
import Parser from 'rss-parser'
import OpenAI from 'openai'
import { Resend } from 'resend'
import chalk from 'chalk'
import { writeFileSync, mkdirSync, readdirSync } from 'fs'
import { join } from 'path'
import { execSync } from 'child_process'

// ── Config ──
const NO_AI = process.argv.includes('--no-ai')
const NO_EMAIL = process.argv.includes('--no-email')
const NO_AUDIO = process.argv.includes('--no-audio')
const BRIEF = process.argv.includes('--brief')  // 8am short edition
const SEND_EMAIL = !NO_EMAIL
const parser = new Parser()
const ai = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: 'https://api.deepseek.com',
})

// ── Mode: brief (8am 10-15min) vs full (3pm 30-40min) ──
const MODE = BRIEF
  ? { label: '☀️ Morning Brief', countSmall: 5, countBig: 8, summaryWords: '20-30词', summaryChars: '20-30字', maxTokens: 1000 }
  : { label: '🌙 Full Edition', countSmall: 10, countBig: 20, summaryWords: '40-60词', summaryChars: '40-80字', maxTokens: 3000 }

// ── Feeds with per-mode counts ──
// HuggingFace + arXiv = ~30% of total content
const FEEDS: { name: string; url: string; color: (s: string) => string; count: number }[] = [
  { name: '🔥 Hacker News',    url: 'https://hnrss.org/frontpage',                                                                      color: chalk.hex('#FF6600'), count: MODE.countSmall },
  { name: '🐙 GitHub Trending', url: 'https://mshibanami.github.io/GitHubTrendingRSS/daily/all.xml',                                    color: chalk.green,          count: MODE.countSmall },
  { name: '📈 Tech/AI Stocks',  url: 'https://feeds.finance.yahoo.com/rss/2.0/headline?s=NVDA,MSFT,GOOGL,META,AMZN,AMD,AVGO,TSM,PLTR,SMCI&region=US&lang=en-US', color: chalk.cyan, count: MODE.countSmall },
  { name: '🤗 HuggingFace',     url: 'https://huggingface.co/blog/feed.xml',                                                            color: chalk.magenta,        count: MODE.countBig },
  { name: '📄 arXiv AI',        url: 'http://export.arxiv.org/rss/cs.AI',                                                               color: chalk.yellow,         count: MODE.countBig },
]

// ── Paths ──
const __dirname = new URL('.', import.meta.url).pathname
const OUTPUT_DIR = join(__dirname, 'output')

// ── Fetch RSS ──
interface NewsItem { title: string; link: string; date?: string }

async function fetchFeed(url: string, count: number): Promise<NewsItem[]> {
  const feed = await parser.parseURL(url)
  return (feed.items || []).slice(0, count).map(item => ({
    title: (item.title || 'No title').replace(/<[^>]*>/g, '').trim(),
    link: item.link || '',
    date: item.pubDate,
  }))
}

// ── AI Summary ──
async function summarize(category: string, items: NewsItem[]): Promise<string[]> {
  if (NO_AI || !process.env.DEEPSEEK_API_KEY || process.env.DEEPSEEK_API_KEY === 'your-key-here') {
    return items.map(() => '')
  }
  const titles = items.map((it, i) => `${i + 1}. ${it.title}`).join('\n')
  try {
    const res = await ai.chat.completions.create({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: `你是新闻摘要助手。对每条新闻给出中英双语概要，格式：\n编号. 英文概要(${MODE.summaryWords}) | 中文概要(${MODE.summaryChars})\n每行一条，不要多余内容。` },
        { role: 'user', content: `分类：${category}\n\n${titles}` },
      ],
      temperature: 0.3,
      max_tokens: MODE.maxTokens,
    })
    const lines = (res.choices[0]?.message?.content || '').trim().split('\n').filter(l => l.trim())
    return items.map((_, i) => {
      const line = lines.find(l => l.startsWith(`${i + 1}.`) || l.startsWith(`${i + 1}、`))
      return line?.replace(/^\d+[.、]\s*/, '').trim() || ''
    })
  } catch (e: any) {
    console.log(chalk.yellow(`  ⚠ AI摘要失败: ${e.message}`))
    return items.map(() => '')
  }
}

// ── HTML Templates ──
interface Section { category: string; items: { title: string; link: string; summary: string }[] }

function buildPageHtml(title: string, date: string, sections: Section[], navHtml = '', audioDate = ''): string {
  const sectionHtml = sections.map(s => {
    if (s.items.length === 0) return `<h2>${s.category}</h2><p class="empty">没有新内容</p>`
    const items = s.items.map(it => {
      const summaryEl = it.summary ? `<p class="summary">${it.summary}</p>` : ''
      return `<li><a href="${it.link}" target="_blank">${it.title}</a>${summaryEl}</li>`
    }).join('\n')
    return `<h2>${s.category}</h2><ul>${items}</ul>`
  }).join('\n')

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 750px; margin: 0 auto; padding: 20px; color: #1a1a1a; line-height: 1.8; background: #fafafa; }
  header { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #eee; padding-bottom: 12px; margin-bottom: 20px; }
  h1 { margin: 0; font-size: 1.5em; }
  .mode-badge { display: inline-block; font-size: 0.7em; padding: 2px 10px; border-radius: 12px; background: #e8f0fe; color: #0969da; margin-left: 10px; vertical-align: middle; }
  nav a { margin-left: 12px; color: #0969da; text-decoration: none; font-size: 0.9em; }
  nav a:hover { text-decoration: underline; }
  h2 { margin-top: 32px; padding-bottom: 6px; border-bottom: 1px solid #eee; }
  ul { list-style: none; padding: 0; }
  li { margin: 14px 0; }
  li a { color: #0969da; text-decoration: none; font-weight: 500; font-size: 1.05em; }
  li a:hover { text-decoration: underline; }
  .summary { margin: 4px 0 0 0; padding: 6px 12px; background: #f0f4f8; border-left: 3px solid #0969da; border-radius: 4px; font-size: 0.88em; color: #555; }
  .empty { color: #999; font-style: italic; }
  .audio-player { background: #f0f4f8; border-radius: 8px; padding: 16px; margin-bottom: 24px; }
  .audio-player p { margin: 8px 0; }
  audio { width: 100%; height: 36px; }
  footer { margin-top: 40px; padding-top: 12px; border-top: 1px solid #eee; font-size: 0.8em; color: #999; text-align: center; }
</style>
</head>
<body>
<header>
  <h1>📰 ${title}<span class="mode-badge">${BRIEF ? 'Brief' : 'Full'}</span></h1>
  <nav>${navHtml}</nav>
</header>
${audioDate ? `<div class="audio-player">
  <p>🔊 语音播报</p>
  <p><strong>English:</strong> <audio controls src="${audioDate}-en.mp3"></audio></p>
  <p><strong>中文:</strong> <audio controls src="${audioDate}-zh.mp3"></audio></p>
</div>` : ''}
${sectionHtml}
<footer>Generated by daily-news • ${date} • ${MODE.label}</footer>
</body>
</html>`
}

function buildArchiveHtml(dates: string[]): string {
  const list = dates.map(d => `<li><a href="${d}.html">${d}</a></li>`).join('\n')
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>📰 Daily News Archive</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #1a1a1a; line-height: 2; background: #fafafa; }
  h1 { border-bottom: 2px solid #eee; padding-bottom: 12px; }
  ul { list-style: none; padding: 0; }
  li { margin: 8px 0; }
  a { color: #0969da; text-decoration: none; font-size: 1.1em; }
  a:hover { text-decoration: underline; }
</style>
</head>
<body>
<h1>📰 Daily News Archive</h1>
<ul>${list}</ul>
</body>
</html>`
}

// ── Main ──
async function main() {
  const suffix = BRIEF ? 'brief' : 'full'
  console.log(chalk.bold(`\n⏳ ${MODE.label} 拉取新闻中...\n`))

  const today = new Date().toISOString().slice(0, 10)
  const sections: Section[] = []
  let totalNew = 0

  for (const feed of FEEDS) {
    const color = feed.color
    console.log(color(`━━ ${feed.name} (${feed.count}条) ━━━━━━━━━━━━━━━━━━`))

    let items: NewsItem[]
    try {
      items = await fetchFeed(feed.url, feed.count)
    } catch (e: any) {
      console.log(chalk.red(`  ✗ 拉取失败: ${e.message}\n`))
      sections.push({ category: feed.name, items: [] })
      continue
    }

    // AI summarize
    const summaries = await summarize(feed.name, items)

    // terminal output
    items.forEach((it, i) => {
      console.log(`  ${color('•')} ${it.title}`)
      if (summaries[i]) console.log(chalk.dim(`    ${summaries[i]}`))
    })
    console.log()

    sections.push({
      category: feed.name,
      items: items.map((it, i) => ({ title: it.title, link: it.link, summary: summaries[i] || '' }))
    })
    totalNew += items.length
  }

  // ── Generate output ──
  mkdirSync(OUTPUT_DIR, { recursive: true })

  const navHtml = `<a href="index.html">最新</a><a href="archive.html">归档</a>`

  // Archive page
  const allDates = readdirSync(OUTPUT_DIR)
    .filter(f => /^\d{4}-\d{2}-\d{2}(-brief|-full)?\.html$/.test(f))
    .filter(f => f !== 'index.html' && f !== 'archive.html')
    .map(f => f.replace('.html', ''))
    .sort()
    .reverse()
  writeFileSync(join(OUTPUT_DIR, 'archive.html'), buildArchiveHtml(allDates))

  // Markdown
  const mdSections = [`# 📰 Daily News — ${today} (${MODE.label})\n`]
  for (const s of sections) {
    if (s.items.length === 0) {
      mdSections.push(`## ${s.category}\n\n> 没有新内容\n`)
    } else {
      const lines = s.items.map(it => {
        const sum = it.summary ? `\n  > ${it.summary}` : ''
        return `- [${it.title}](${it.link})${sum}`
      })
      mdSections.push(`## ${s.category}\n\n${lines.join('\n')}\n`)
    }
  }
  writeFileSync(join(OUTPUT_DIR, `${today}-${suffix}.md`), mdSections.join('\n'))

  // Audio via Python edge-tts
  let audioPath = ''
  if (!NO_AUDIO) {
    try {
      console.log(chalk.dim('  🔊 生成语音播报...'))
      // English: titles + english summary part
      const enText = sections
        .filter(s => s.items.length > 0)
        .map(s => {
          const heading = s.category.replace(/[^\w\s]/g, '')
          const lines = s.items.map(it => {
            const enSummary = it.summary?.split('|')[0]?.trim()
            return enSummary ? `${it.title}. ${enSummary}` : it.title
          })
          return `${heading}.\n${lines.join('.\n')}`
        })
        .join('.\n\n')

      // Chinese: chinese summary part
      const zhText = sections
        .filter(s => s.items.length > 0)
        .map(s => {
          const heading = s.category.replace(/[^\w\s]/g, '')
          const lines = s.items.map(it => {
            const zh = it.summary?.split('|')[1]?.trim()
            return zh || it.title
          })
          return `${heading}。\n${lines.join('。\n')}`
        })
        .join('。\n\n')

      const enPath = join(OUTPUT_DIR, `${today}-${suffix}-en.mp3`)
      const zhPath = join(OUTPUT_DIR, `${today}-${suffix}-zh.mp3`)
      const enTmpFile = join(OUTPUT_DIR, '.tmp-en.txt')
      const zhTmpFile = join(OUTPUT_DIR, '.tmp-zh.txt')
      writeFileSync(enTmpFile, enText)
      writeFileSync(zhTmpFile, zhText)

      // Slower rate for brief (clear listening), normal for full
      const rate = BRIEF ? '-10%' : '+0%'
      execSync(`edge-tts --voice en-US-AriaNeural --rate="${rate}" --file "${enTmpFile}" --write-media "${enPath}"`, { stdio: 'pipe' })
      execSync(`edge-tts --voice zh-CN-XiaoxiaoNeural --rate="${rate}" --file "${zhTmpFile}" --write-media "${zhPath}"`, { stdio: 'pipe' })
      execSync(`rm -f "${enTmpFile}" "${zhTmpFile}"`)

      audioPath = `${today}-${suffix}`
      console.log(chalk.dim(`   🔊 英文: output/${today}-${suffix}-en.mp3`))
      console.log(chalk.dim(`   🔊 中文: output/${today}-${suffix}-zh.mp3`))
    } catch (e: any) {
      console.log(chalk.yellow(`  ⚠ 语音生成失败: ${e.message}`))
    }
  }

  // Daily HTML
  const dailyHtml = buildPageHtml(`Daily News — ${today}`, today, sections, navHtml, audioPath)
  const dailyPath = join(OUTPUT_DIR, `${today}-${suffix}.html`)
  writeFileSync(dailyPath, dailyHtml)
  writeFileSync(join(OUTPUT_DIR, 'index.html'), dailyHtml)

  console.log(chalk.bold.green(`\n✅ ${MODE.label} 完成！${totalNew} 条内容`))
  console.log(chalk.dim(`   HTML: ${dailyPath}`))
  console.log(chalk.dim(`   首页: output/index.html`))
  console.log(chalk.dim(`   归档: output/archive.html\n`))

  // ── Email ──
  if (SEND_EMAIL && process.env.RESEND_API_KEY && process.env.EMAIL_TO) {
    const resend = new Resend(process.env.RESEND_API_KEY)
    const PAGES_URL = 'https://2045max.github.io/daily-news'
    const emailHtml = dailyHtml.replace(
      /<div class="audio-player">[\s\S]*?<\/div>/,
      `<div style="background:#f0f4f8;border-radius:8px;padding:20px;margin-bottom:24px;text-align:center;">
        <p style="margin:0 0 12px 0;font-size:1.1em;font-weight:600;">🔊 语音播报 / Audio Briefing</p>
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;">
          <tr>
            <td style="padding:0 8px;">
              <a href="${PAGES_URL}/${today}-${suffix}-en.mp3" style="display:inline-block;background:#0969da;color:#ffffff;text-decoration:none;padding:10px 24px;border-radius:6px;font-size:0.95em;font-weight:500;">▶ English</a>
            </td>
            <td style="padding:0 8px;">
              <a href="${PAGES_URL}/${today}-${suffix}-zh.mp3" style="display:inline-block;background:#0969da;color:#ffffff;text-decoration:none;padding:10px 24px;border-radius:6px;font-size:0.95em;font-weight:500;">▶ 中文版</a>
            </td>
          </tr>
        </table>
        <p style="margin:12px 0 0 0;font-size:0.85em;color:#666;">点击收听语音播报，或访问 <a href="${PAGES_URL}/" style="color:#0969da;text-decoration:underline;">网页版</a> 在线播放</p>
      </div>`
    )
    try {
      await resend.emails.send({
        from: 'Daily News <onboarding@resend.dev>',
        to: process.env.EMAIL_TO,
        subject: `📰 ${MODE.label} — ${today}`,
        html: emailHtml,
      })
      console.log(chalk.green(`📧 邮件已发送到 ${process.env.EMAIL_TO}`))
    } catch (e: any) {
      console.log(chalk.yellow(`⚠ 邮件发送失败: ${e.message}`))
    }
  }

  // ── Webhook ──
  if (process.env.WEBHOOK_URL) {
    try {
      await fetch(process.env.WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: mdSections.join('\n') }),
      })
      console.log(chalk.green('📤 已推送到 Webhook'))
    } catch (e: any) {
      console.log(chalk.yellow(`⚠ 推送失败: ${e.message}`))
    }
  }
}

main().catch(e => { console.error(chalk.red(e.message)); process.exit(1) })
