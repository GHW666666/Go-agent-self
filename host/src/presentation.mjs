import pptxgen from 'pptxgenjs'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

const COLORS = { ink: '172033', muted: '5F6B7A', accent: '176B87', line: 'D9E2E8', paper: 'F7FAFB', white: 'FFFFFF' }
const layouts = new Set(['title-content', 'two-column', 'table', 'title-only'])

function requiredText(value, label) {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} 不能为空`)
    return value.trim()
}

function addTitle(slide, title, subtitle) {
    slide.addText(title, { x: 0.65, y: 0.45, w: 12, h: 0.45, fontFace: 'Aptos Display', fontSize: 24, bold: true, color: COLORS.ink, margin: 0 })
    slide.addShape('line', { x: 0.65, y: 1.08, w: 12, h: 0, line: { color: COLORS.accent, width: 1.5 } })
    if (subtitle) slide.addText(subtitle, { x: 0.65, y: 1.18, w: 12, h: 0.3, fontFace: 'Aptos', fontSize: 10, color: COLORS.muted, margin: 0 })
}

function addBullets(slide, items, x, y, w, h) {
    if (!Array.isArray(items) || items.length === 0) throw new Error('bullets 至少需要一项')
    slide.addText(items.map((item) => requiredText(item, '要点')).join('\n'), { x, y, w, h, fontFace: 'Aptos', fontSize: 18, color: COLORS.ink, bullet: { type: 'ul' }, paraSpaceAfterPt: 14, margin: 0.08, fit: 'shrink', valign: 'mid' })
}

function getBullets(data) {
    if (Array.isArray(data.bullets)) return data.bullets
    if (Array.isArray(data.items)) return data.items
    if (Array.isArray(data.content)) return data.content
    if (Array.isArray(data.content?.items)) return data.content.items
    if (Array.isArray(data.content?.bullets)) return data.content.bullets
    return undefined
}

function addBodySlide(pptx, data, index) {
    const layout = data.layout ?? 'title-content'
    if (!layouts.has(layout)) throw new Error(`不支持的幻灯片布局：${layout}`)
    const slide = pptx.addSlide()
    slide.background = { color: COLORS.paper }
    addTitle(slide, requiredText(data.title, `第 ${index + 1} 页标题`), data.subtitle)
    if (layout === 'title-only') return

    if (layout === 'title-content') {
        if (typeof data.content === 'string') slide.addText(requiredText(data.content, '正文'), { x: 0.8, y: 1.75, w: 11.7, h: 4.8, fontFace: 'Aptos', fontSize: 20, color: COLORS.ink, margin: 0.08, fit: 'shrink', valign: 'mid' })
        else if (data.content?.type === 'text') slide.addText(requiredText(data.content.text, '正文'), { x: 0.8, y: 1.75, w: 11.7, h: 4.8, fontFace: 'Aptos', fontSize: 20, color: COLORS.ink, margin: 0.08, fit: 'shrink', valign: 'mid' })
        else addBullets(slide, getBullets(data), 0.85, 1.75, 11.5, 4.8)
        return
    }

    if (layout === 'two-column') {
        for (const [column, x] of [['left', 0.8], ['right', 6.85]]) {
            const value = data[column]
            slide.addShape('roundRect', { x, y: 1.7, w: 5.55, h: 4.85, fill: { color: COLORS.white }, line: { color: COLORS.line, width: 1 } })
            slide.addText(requiredText(value?.title, `${column} 标题`), { x: x + 0.3, y: 2.0, w: 4.95, h: 0.35, fontFace: 'Aptos Display', fontSize: 17, bold: true, color: COLORS.accent, margin: 0 })
            addBullets(slide, getBullets(value ?? {}), x + 0.3, 2.55, 4.95, 3.5)
        }
        return
    }

    if (!Array.isArray(data.headers) || !Array.isArray(data.rows) || !data.rows.length) throw new Error('table 布局需要 headers 和 rows')
    const rows = [data.headers, ...data.rows].map((row) => row.map((cell) => requiredText(String(cell), '表格内容')))
    slide.addTable(rows, { x: 0.8, y: 1.75, w: 11.7, h: 4.8, border: { type: 'solid', color: COLORS.line, pt: 1 }, fill: COLORS.white, color: COLORS.ink, fontFace: 'Aptos', fontSize: 14, margin: 0.12, valign: 'mid', fit: 'shrink', rowH: 0.48 })
}

export async function createPresentation({ outputPath, title, subtitle, slides, theme = 'clean-blue' }) {
    const filePath = requiredText(outputPath, '输出路径')
    const deckTitle = requiredText(title, '演示文稿标题')
    if (!Array.isArray(slides) || slides.length === 0 || slides.length > 30) throw new Error('slides 需要 1 到 30 页')
    if (theme !== 'clean-blue') throw new Error(`不支持的主题：${theme}`)

    const pptx = new pptxgen()
    pptx.layout = 'LAYOUT_WIDE'
    pptx.author = 'Goagent'
    pptx.title = deckTitle
    pptx.subject = deckTitle
    pptx.company = 'Goagent'
    pptx.lang = 'zh-CN'

    const cover = pptx.addSlide()
    cover.background = { color: COLORS.accent }
    cover.addText(deckTitle, { x: 0.9, y: 2.1, w: 11.5, h: 1.2, fontFace: 'Aptos Display', fontSize: 34, bold: true, color: COLORS.white, margin: 0, fit: 'shrink', valign: 'mid' })
    if (subtitle) cover.addText(subtitle, { x: 0.95, y: 3.55, w: 10.8, h: 0.5, fontFace: 'Aptos', fontSize: 18, color: 'D8EEF3', margin: 0, fit: 'shrink' })

    slides.forEach((slide, index) => addBodySlide(pptx, slide, index))
    await mkdir(dirname(filePath), { recursive: true })
    await pptx.writeFile({ fileName: filePath })
    return { path: filePath, slides: slides.length + 1, theme }
}
