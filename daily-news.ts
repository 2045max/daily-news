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
const SEND_EMAIL = !NO_EMAIL
const parser = new Parser()
const ai = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: 'https://api.deepseek.com',
})

const FEEDS = {
  '🔥 Hacker News': 'https://hnrss.org/frontpage?count=10',
  '🐙 GitHub Trending': 'https://mshibanami.github.io/GitHubTrendingRSS/daily/all.xml',
  '📈 Tech/AI Stocks': 'https://feeds.finance.yahoo.com/rss/2.0/headline?s=NVDA,MSFT,GOOGL,META,AMZN,AMD,AVGO,TSM,PLTR,SMCI&region=US&lang=en-US',
}

const COLORS: Record<string, (s: string) => string> = {
  '🔥 Hacker News': chalk.hex('#FF6600'),
  '🐙 GitHub Trending': chalk.green,
  '📈 Tech/AI Stocks': chalk.cyan,
}

// ── Paths ──
const __dirname = new URL('.', import.meta.url).pathname
const OUTPUT_DIR = join(__dirname, 'output')

// ── Fetch RSS ──
interface NewsItem { title: string; link: string; date?: string }

async function fetchFeed(url: string): Promise<NewsItem[]> {
  const feed = await parser.parseURL(url)
  return (feed.items || []).slice(0, 10).map(item => ({
    title: item.title || 'No title',
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
        { role: 'system', content: '你是新闻摘要助手。对每条新闻给出中英双语概要，格式：\n编号. 英文概要(30-50词) | 中文概要(30-50字)\n每行一条，不要多余内容。' },
        { role: 'user', content: `分类：${category}\n\n${titles}` },
      ],
      temperature: 0.3,
      max_tokens: 1500,
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
  <h1>📰 ${title}</h1>
  <nav>${navHtml}</nav>
</header>
${audioDate ? `<div class="audio-player">
  <p>🔊 语音播报</p>
  <p><strong>English:</strong> <audio controls src="${audioDate}-en.mp3"></audio></p>
  <p><strong>中文:</strong> <audio controls src="${audioDate}-zh.mp3"></audio></p>
</div>` : ''}
${sectionHtml}
<footer>Generated by daily-news • ${date}</footer>
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
  console.log(chalk.bold('\n⏳ 拉取新闻中...\n'))

  const today = new Date().toISOString().slice(0, 10)
  const sections: Section[] = []
  let totalNew = 0

  for (const [category, url] of Object.entries(FEEDS)) {
    const color = COLORS[category] || chalk.white
    console.log(color(`━━ ${category} ━━━━━━━━━━━━━━━━━━━━━━━`))

    let items: NewsItem[]
    try {
      items = await fetchFeed(url)
    } catch (e: any) {
      console.log(chalk.red(`  ✗ 拉取失败: ${e.message}\n`))
      sections.push({ category, items: [] })
      continue
    }

    const newItems = items

    // AI summarize
    const summaries = await summarize(category, newItems)

    // terminal output
    newItems.forEach((it, i) => {
      console.log(`  ${color('•')} ${it.title}`)
      if (summaries[i]) console.log(chalk.dim(`    ${summaries[i]}`))
    })
    console.log()

    sections.push({
      category,
      items: newItems.map((it, i) => ({ title: it.title, link: it.link, summary: summaries[i] || '' }))
    })
    totalNew += newItems.length
  }

  // ── Generate output ──
  mkdirSync(OUTPUT_DIR, { recursive: true })

  const navHtml = `<a href="index.html">最新</a><a href="archive.html">归档</a>`

  // (HTML generated after audio, see below)

  // 3. Archive page
  const allDates = readdirSync(OUTPUT_DIR)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.html$/.test(f))
    .map(f => f.replace('.html', ''))
    .sort()
    .reverse()
  writeFileSync(join(OUTPUT_DIR, 'archive.html'), buildArchiveHtml(allDates))

  // 4. Markdown (keep for reference)
  const mdSections = [`# 📰 Daily News — ${today}\n`]
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
  writeFileSync(join(OUTPUT_DIR, `${today}.md`), mdSections.join('\n'))

  // 5. Audio (English first, then Chinese) via Python edge-tts
  let audioPath = ''
  if (!NO_AUDIO) {
    try {
      console.log(chalk.dim('  🔊 生成语音播报...'))
      const enText = sections
        .filter(s => s.items.length > 0)
        .map(s => `${s.category.replace(/[^\w\s]/g, '')}.\n${s.items.map(it => it.title).join('.\n')}`)
        .join('.\n\n')
      const zhText = sections
        .filter(s => s.items.length > 0)
        .map(s => {
          const zhLines = s.items.map(it => {
            const zh = it.summary?.split('|')[1]?.trim()
            return zh || it.title  // fallback to English title
          })
          return `${s.category.replace(/[^\w\s]/g, '')}。\n${zhLines.join('。\n')}`
        })
        .join('。\n\n')

      const enPath = join(OUTPUT_DIR, `${today}-en.mp3`)
      const zhPath = join(OUTPUT_DIR, `${today}-zh.mp3`)

      // Write temp text files then call edge-tts
      const enTmpFile = join(OUTPUT_DIR, '.tmp-en.txt')
      const zhTmpFile = join(OUTPUT_DIR, '.tmp-zh.txt')
      writeFileSync(enTmpFile, enText)
      writeFileSync(zhTmpFile, zhText)

      execSync(`edge-tts --voice en-US-AriaNeural --file "${enTmpFile}" --write-media "${enPath}"`, { stdio: 'pipe' })
      execSync(`edge-tts --voice zh-CN-XiaoxiaoNeural --file "${zhTmpFile}" --write-media "${zhPath}"`, { stdio: 'pipe' })

      // cleanup tmp
      execSync(`rm -f "${enTmpFile}" "${zhTmpFile}"`)

      audioPath = `${today}`
      console.log(chalk.dim(`   🔊 英文: output/${today}-en.mp3`))
      console.log(chalk.dim(`   🔊 中文: output/${today}-zh.mp3`))
    } catch (e: any) {
      console.log(chalk.yellow(`  ⚠ 语音生成失败: ${e.message}`))
    }
  }

  // 1. Daily HTML (after audio so we can embed player)
  const dailyHtml = buildPageHtml(`Daily News — ${today}`, today, sections, navHtml, audioPath)
  const dailyPath = join(OUTPUT_DIR, `${today}.html`)
  writeFileSync(dailyPath, dailyHtml)

  // 2. index.html (copy of today)
  writeFileSync(join(OUTPUT_DIR, 'index.html'), dailyHtml)

  console.log(chalk.bold.green(`\n✅ 完成！${totalNew} 条新内容`))
  console.log(chalk.dim(`   HTML: ${dailyPath}`))
  console.log(chalk.dim(`   首页: output/index.html`))
  console.log(chalk.dim(`   归档: output/archive.html\n`))

  // ── Email ──
  if (SEND_EMAIL && process.env.RESEND_API_KEY && process.env.EMAIL_TO) {
    const resend = new Resend(process.env.RESEND_API_KEY)
    try {
      await resend.emails.send({
        from: 'Daily News <onboarding@resend.dev>',
        to: process.env.EMAIL_TO,
        subject: `📰 Daily News — ${today}`,
        html: dailyHtml,
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
