#!/usr/bin/env node
// M2 的验收：权限边界。
//
// 刻意**不联网、不烧 token**。要验的是安全边界本身 —— 路径越狱。
// 这是整个项目里唯一一处「写错了就等于把用户硬盘交出去」的地方，
// 值得一个专门跑、秒出结果的脚本，而不是靠某次端到端演示顺手带过。
//
//   node scripts/smoke-m2.mjs
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonical, isGranted, safePath } from '../host/src/grants.mjs'

let failed = 0
const ok = (msg) => console.log(`  ✓ ${msg}`)
function check(msg, fn) {
  try {
    fn()
    ok(msg)
  } catch (err) {
    failed++
    console.log(`  ✗ ${msg}\n      ${err.message.split('\n')[0]}`)
  }
}

// 搭一棵临时目录树。真建真文件 —— 拿字符串摆样子测不出 realpath 那一段。
const tmp = await mkdtemp(join(tmpdir(), 'goagent-m2-'))
const work = join(tmp, 'work')
// 名字故意只差一个后缀：字符串前缀比较正是在这儿翻车的
// （work 会被当成 workspace 的父目录）。
const workspace = join(tmp, 'workspace')
const secret = join(tmp, 'secret')

await mkdir(join(work, 'sub'), { recursive: true })
await mkdir(workspace, { recursive: true })
await mkdir(secret, { recursive: true })
await writeFile(join(work, 'note.txt'), 'hello')
await writeFile(join(secret, 'id_rsa'), '-----BEGIN PRIVATE KEY-----')

console.log(`\n临时目录 ${tmp}\n\n只授权了 ${canonical(work)}\n`)

const grants = [canonical(work)]
const allow = (p) => safePath(grants, p)
const deny = (p) => assert.throws(() => safePath(grants, p), undefined, `本该拒掉：${p}`)

// ---------------------------------------------------------------- 该放行
check('授权目录里的文件', () => {
  assert.equal(allow(join(work, 'note.txt')), canonical(join(work, 'note.txt')))
})
check('授权目录本身', () => assert.equal(allow(work), canonical(work)))
check('中间的 .. 会被规整掉，仍落在目录内', () => {
  assert.equal(allow(join(work, 'sub', '..', 'note.txt')), canonical(join(work, 'note.txt')))
})

// ---------------------------------------------------------------- 该拦
check('授权目录之外的文件', () => deny(join(secret, 'id_rsa')))
check('名字只差一个后缀的兄弟目录', () => deny(workspace))
check('用 .. 爬出去', () => deny(join(work, '..', 'secret', 'id_rsa')))
check('爬到更上面', () => deny(join(work, '..', '..')))
check('相对路径不在契约里（必须绝对）', () => deny('note.txt'))

// 零授权起步是这套安全模型的默认状态 —— 也是最该确认的一条：
// 用户什么都没批的时候，agent 必须什么也碰不到。
check('一个目录都没授权时，什么都不放行', () => {
  assert.throws(() => safePath([], join(work, 'note.txt')))
  assert.equal(isGranted([], canonical(work)), false)
})

// 拒绝信息是**写给模型看的**：不指路的话它只会换个路径再试一次，
// 而它真正该做的是去调 request_access。
check('拒绝信息要告诉模型下一步调 request_access', () => {
  try {
    safePath([], join(work, 'note.txt'))
    assert.fail('本该抛')
  } catch (err) {
    assert.match(err.message, /request_access/)
  }
})

// 符号链接：canonical 走 realpath，链接会被解到真实位置再判，
// 所以「授权目录里的一个链接指向外面」也拦得住 —— 这是 canonical 存在的理由。
// Windows 上建链接要权限，建不出来就跳过，不算失败。
{
  const link = join(work, 'escape')
  try {
    await symlink(secret, link, 'junction')
    check('指向外面的符号链接会被拦下', () => deny(join(link, 'id_rsa')))
  } catch {
    console.log('  · 跳过一个：这台机器不让建符号链接（需要管理员或用开发者模式）')
  }
}

console.log(failed ? `\n✗ M2 有 ${failed} 条没过\n` : '\n✓ M2 权限边界全部通过\n')
process.exit(failed ? 1 : 0)
