// 这台电脑在中继那边的身份：配对码 + token。
//
// 存在用户目录而不是仓库里 —— 它是这台机器的身份，不该跟着代码被 clone、
// 也不该被一次 force push 冲掉。换台电脑就是一次新配对，这是对的。
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { randomBytes, randomInt } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

// 冒烟测试用 GOAGENT_CONFIG 指到临时文件，免得踩到你自己那份真配置。
export const configPath = process.env.GOAGENT_CONFIG ?? join(homedir(), '.goagent', 'config.json')

// 去掉了 0/O/1/I/L —— 这串码要人从屏幕上念到手机里敲，认错的代价比多几位大。
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

export function newCode() {
  // randomInt 是无偏的。取字节再取模会有偏差，虽然对配对码无所谓，
  // 但 crypto 模块本来就有现成的，没理由手搓。
  return Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('')
}

export async function save(cfg) {
  await mkdir(dirname(configPath), { recursive: true })
  await writeFile(configPath, JSON.stringify(cfg, null, 2) + '\n')
  return cfg
}

export async function load() {
  try {
    const cfg = JSON.parse(await readFile(configPath, 'utf8'))
    if (cfg.code && cfg.token) return cfg
  } catch {
    // 第一次跑，或者文件被删了 —— 下面重新生成
  }
  return save({ code: newCode(), token: randomBytes(16).toString('hex') })
}
