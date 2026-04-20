import 'dotenv/config'
import Parser from 'rss-parser'
import OpenAI from 'openai'
import { Resend } from 'resend'
import chalk from 'chalk'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'

// ── Config ──
const NO_AI = process.argv.includes('--no-ai')
const SEND_EMAIL = process.argv.includes('--email')
const parser = new Parser()
const ai = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: 'https://api.deepseek.com',
})

const FEEDS = {
  '🔥 Hacker News': 'https://hnrss.org/frontpage?count=10',
  '🐙 GitHub Trending': 'https://mshibanami.github.io/GitHubTrendingRSS/daily/all.xml',
  '📈 US Stocks': 'https://feeds.finance.yahoo.com/rss/2.0/headline?s=AAPL,MSFT,GOOGL,NVDA,TSLA&region=US&lang=en-US',
}

const COLORS: Record<string, (s: string) => string> = {
  '🔥 Hacker News': chalk.hex('#FF6600'),
  '🐙 GitHub Trending': chalk.green,
  '📈 US Stocks': chalk.cyan,
}

// ── Cache (simple JSON file for dedup) ──
const __dirname = new URL('.', import.meta.url).pathname
const CACHE_FILE = join(__dirname, '.news-cache.json')
const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000

function loadCache(): Record<string, number> {
  if (!existsSync(CACHE_FILE)) return {}
  try { return JSON.parse(readFileSync(CACHE_FILE, 'utf-8')) } catch { return {} }
}

function saveCache(cache: Record<string, number>) {
  const now = Date.now()
  // prune entries older than 7 days
  const pruned = Object.fromEntries(
    Object.entries(cache).filter(([, ts]) => now - ts < SEVEN_DAYS)
  )
  writeFileSync(CACHE_FILE, JSON.stringify(pruned, null, 2))
}

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

// ── AI Summary (one call per category) ──
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

// ── Main ──
async function main() {
  console.log(chalk.bold('\n⏳ 拉取新闻中...\n'))

  const cache = loadCache()
  const today = new Date().toISOString().slice(0, 10)
  const mdSections: string[] = [`# 📰 Daily News — ${today}\n`]
  let totalNew = 0

  for (const [category, url] of Object.entries(FEEDS)) {
    const color = COLORS[category] || chalk.white
    console.log(color(`━━ ${category} ━━━━━━━━━━━━━━━━━━━━━━━`))

    let items: NewsItem[]
    try {
      items = await fetchFeed(url)
    } catch (e: any) {
      console.log(chalk.red(`  ✗ 拉取失败: ${e.message}\n`))
      mdSections.push(`## ${category}\n\n> 拉取失败\n`)
      continue
    }

    // dedup
    const newItems = items.filter(it => !cache[it.link])
    newItems.forEach(it => { cache[it.link] = Date.now() })

    if (newItems.length === 0) {
      console.log(chalk.dim('  (没有新内容)\n'))
      mdSections.push(`## ${category}\n\n> 没有新内容\n`)
      continue
    }

    // AI summarize
    const summaries = await summarize(category, newItems)

    // terminal output
    newItems.forEach((it, i) => {
      console.log(`  ${color('•')} ${it.title}`)
      if (summaries[i]) {
        console.log(chalk.dim(`    ${summaries[i]}`))
      }
    })
    console.log()

    // markdown
    const mdLines = newItems.map((it, i) => {
      const summary = summaries[i] ? `\n  > ${summaries[i]}` : ''
      return `- [${it.title}](${it.link})${summary}`
    })
    mdSections.push(`## ${category}\n\n${mdLines.join('\n')}\n`)

    totalNew += newItems.length
  }

  // save cache
  saveCache(cache)

  // write markdown
  mkdirSync(join(__dirname, 'output'), { recursive: true })
  const mdPath = join(__dirname, 'output', `daily-news-${today}.md`)
  writeFileSync(mdPath, mdSections.join('\n'))

  console.log(chalk.bold.green(`✅ 完成！${totalNew} 条新内容 → ${mdPath}\n`))

  // optional webhook push
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

  // optional email via Resend
  if (SEND_EMAIL && process.env.RESEND_API_KEY && process.env.EMAIL_TO) {
    const resend = new Resend(process.env.RESEND_API_KEY)
    const html = mdToHtml(mdSections.join('\n'))
    try {
      await resend.emails.send({
        from: 'Daily News <onboarding@resend.dev>',
        to: process.env.EMAIL_TO,
        subject: `📰 Daily News — ${today}`,
        html,
      })
      console.log(chalk.green(`📧 邮件已发送到 ${process.env.EMAIL_TO}`))
    } catch (e: any) {
      console.log(chalk.yellow(`⚠ 邮件发送失败: ${e.message}`))
    }
  }
}

// ── Markdown → HTML ──
function mdToHtml(md: string): string {
  const body = md
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^  > (.+)$/gm, '<p class="summary">$1</p>')
    .replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>')
    .replace(/^- \[([^\]]+)\]\(([^)]+)\)$/gm, '<li><a href="$2">$1</a></li>')
    .replace(/\n/g, '\n')

  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
  body { font-family: -apple-system, sans-serif; max-width: 720px; margin: 40px auto; padding: 0 20px; color: #333; line-height: 1.7; }
  h1 { border-bottom: 2px solid #eee; padding-bottom: 10px; }
  h2 { margin-top: 30px; color: #1a1a1a; }
  li { margin: 12px 0; }
  a { color: #0969da; text-decoration: none; font-weight: 500; }
  a:hover { text-decoration: underline; }
  .summary { margin: 2px 0 12px 20px; padding: 6px 12px; background: #f6f8fa; border-left: 3px solid #0969da; border-radius: 4px; font-size: 0.9em; color: #555; }
  blockquote { color: #666; border-left: 3px solid #ddd; padding-left: 12px; }
</style></head><body>${body}</body></html>`
}

main().catch(e => { console.error(chalk.red(e.message)); process.exit(1) })
