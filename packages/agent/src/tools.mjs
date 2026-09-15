import { readFile, readdir } from 'node:fs/promises'
import { resolve, relative, isAbsolute } from 'node:path'
import { Type } from 'typebox'

// 所有工具都被关在这个目录里。
// Step 1 只给只读工具 + 路径越界检查 —— 现在还没有审批环节，
// 让一个自动放行的模型能写文件、能执行命令是很糟的主意。
// 等 Step 3 接上 beforeToolCall 审批，再加能写、能执行的工具。
const workspace = resolve(process.env.GOAGENT_WORKSPACE ?? process.cwd())

// 把模型给的路径解析成绝对路径，并拒绝任何逃出 workspace 的尝试。
// relative() 比字符串前缀比较可靠：它自己处理 ./ ../ 和 Windows 的大小写盘符。
function safePath(p) {
  const abs = resolve(workspace, p)
  const rel = relative(workspace, abs)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`路径越界，只允许访问工作目录内的文件: ${p}`)
  }
  return abs
}

export const tools = [
  {
    name: 'read_file',
    label: 'Read File',
    description: '读取一个文件的内容。路径相对于工作目录。',
    parameters: Type.Object({
      path: Type.String({ description: '相对于工作目录的文件路径' }),
    }),
    execute: async (_toolCallId, { path }) => {
      const abs = safePath(path)
      const text = await readFile(abs, 'utf8')
      return {
        content: [{ type: 'text', text }],
        details: { path, bytes: Buffer.byteLength(text) },
      }
    },
  },

  {
    name: 'list_dir',
    label: 'List Directory',
    description: '列出目录下的文件和子目录。用 "." 表示工作目录本身。',
    parameters: Type.Object({
      path: Type.String({ description: '相对于工作目录的目录路径，"." 表示根' }),
    }),
    execute: async (_toolCallId, { path }) => {
      const abs = safePath(path)
      const entries = await readdir(abs, { withFileTypes: true })
      const text = entries
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .sort()
        .join('\n')
      return {
        content: [{ type: 'text', text: text || '(空目录)' }],
        details: { count: entries.length },
      }
    },
  },
]
