// 这台电脑允许 agent 碰哪些目录。
//
// **初始是空的，这是故意的。** 一个自动放行的模型不该默认能翻你的硬盘 ——
// 「零权限起步、用户逐目录授权」就是这套东西的全部安全模型。
// 授权记在 config.json 里，重启还在；用户哪天不放心，删掉那一行就行。
//
// v1 只有一个固定的 workspace 根。这里换成一**组**根，因为授权是逐个给的。
import { realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

// 路径规整成绝对路径。目录存在的话走 realpath：Windows 上短名（PROGRA~1）、
// 盘符大小写、符号链接会让同一个目录看起来像好几个，而授权是拿字符串比的 ——
// 不规整的话「已授权 C:\Users\x\Desktop，模型给的是 c:\users\x\desktop」
// 会被判成越界，用户会看到一个莫名其妙的拒绝。
export function canonical(p) {
  const abs = resolve(p)
  try {
    return realpathSync.native(abs)
  } catch {
    return abs // 不存在（打错了、或者刚要授权的目录被删了），按字面存
  }
}

// 判断 abs 落不落在 root 里面。
//
// 用 relative() 而不是字符串前缀比较：它自己处理 ./ ../ 和盘符大小写，
// 而前缀比较会把 C:\a 当成 C:\ab 的父目录。这是 v1 那段安全代码的核心，
// 一字没动，只是从「一个根」变成「一组根」。
function contains(root, abs) {
  const rel = relative(root, abs)
  return !rel.startsWith('..') && !isAbsolute(rel)
}

export function isGranted(grants, abs) {
  return grants.some((root) => contains(root, abs))
}

// 把模型给的路径解析成绝对路径，落在授权之外就抛。
//
// 报错信息是**写给模型看的**，不是写给人看的：它得知道现在能碰哪儿、
// 以及下一步该调什么。只说「无权访问」的话，模型只会换个路径再试一次。
export function safePath(grants, p) {
  if (typeof p !== 'string' || !p.trim()) throw new Error('路径不能为空')
  const abs = canonical(p)
  if (!isGranted(grants, abs)) {
    const list = grants.length ? grants.map((g) => `  ${g}`).join('\n') : '  （一个都没有）'
    throw new Error(
      `${abs} 不在已授权的目录里，我碰不到。\n` +
        `现在能访问的只有：\n${list}\n` +
        `确实需要的话，用 request_access 申请它，用户会在手机上确认。`,
    )
  }
  return abs
}
