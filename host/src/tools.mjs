// agent 能用的工具。全部**只读**，全部受授权目录约束。
//
// 为什么先只给只读：一个自动放行的模型加上写权限或执行权限，等于把电脑交出去。
// 现在最坏的情况是——它读到了你亲手指定的那个目录里的东西，仅此而已。
//
// 参数 schema 用**朴素的 JSON Schema**，没有引 typebox。typebox 在 host/ 下
// 解析不到（它只是 pi 的传递依赖，pnpm 不会提升到能用），而这里要的不过是
// 几个字符串字段。TypeBox 的 Type.Object 产出的本来就是 JSON Schema，运行时等价。
import { readFile, readdir, stat } from 'node:fs/promises'
import { canonical, isGranted, safePath } from './grants.mjs'

// 读进来就直接进模型上下文，没有文件附件类型可以绕开。所以必须封顶 ——
// 不封的话一句「读一下这个日志」就能把整个上下文撑爆。
const MAX_READ = 64 * 1024

const str = (description) => ({ type: 'string', description })
const text = (t) => ({ content: [{ type: 'text', text: t }] })

export function makeTools({ list, add, ask }) {
  return [
    {
      name: 'list_dir',
      label: '列目录',
      description:
        '列出目录下的文件和子目录。路径必须是绝对路径，且所在目录已被用户授权。' +
        '没授权的话先用 request_access 申请。',
      parameters: {
        type: 'object',
        properties: { path: str('目录的绝对路径') },
        required: ['path'],
      },
      execute: async (_id, { path }) => {
        const abs = safePath(list(), path)
        const entries = await readdir(abs, { withFileTypes: true })
        const body = entries
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
          .sort()
          .join('\n')
        return { ...text(body || '(空目录)'), details: { path: abs, count: entries.length } }
      },
    },

    {
      name: 'read_file',
      label: '读文件',
      description: '读取一个文本文件的内容。路径必须是绝对路径，且所在目录已被用户授权。',
      parameters: {
        type: 'object',
        properties: { path: str('文件的绝对路径') },
        required: ['path'],
      },
      execute: async (_id, { path }) => {
        const abs = safePath(list(), path)
        const st = await stat(abs)
        if (st.isDirectory()) throw new Error(`${abs} 是个目录，列目录要用 list_dir`)
        if (st.size > MAX_READ) {
          throw new Error(
            `${abs} 有 ${Math.round(st.size / 1024)}KB，超过我一次能读的上限` +
              `（${MAX_READ / 1024}KB）。告诉用户这个文件太大，让他们想别的办法。`,
          )
        }
        const body = await readFile(abs, 'utf8')
        return { ...text(body), details: { path: abs, bytes: Buffer.byteLength(body) } }
      },
    },

    {
      name: 'request_access',
      label: '申请目录权限',
      description:
        '申请访问一个目录。用户会在手机上看到确认框，点了同意你才有权限。' +
        '被拒绝了就不要再申请同一个目录，直接告诉用户这件事做不了。',
      parameters: {
        type: 'object',
        properties: {
          path: str('要申请的目录绝对路径'),
          reason: str('为什么需要它。这句话会原样显示给用户看，写具体一点'),
        },
        required: ['path', 'reason'],
      },
      execute: async (_id, { path, reason }, signal) => {
        const abs = canonical(path)

        // 已经有权限就别去打扰用户 —— 模型经常会保险起见先申请一下。
        if (isGranted(list(), abs)) {
          return { ...text(`已经有 ${abs} 的权限了，直接用 list_dir / read_file。`), details: { granted: true } }
        }

        const ok = await ask(abs, reason, signal)
        if (!ok) {
          return {
            ...text(`用户拒绝了 ${abs}。不要重复申请同一个目录，把这件事如实告诉用户。`),
            details: { granted: false },
          }
        }

        await add(abs)
        return { ...text(`用户已同意。现在可以访问 ${abs} 了。`), details: { granted: true } }
      },
    },
  ]
}
