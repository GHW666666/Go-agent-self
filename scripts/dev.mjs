import { execFileSync, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import process from 'node:process'

const ports = [8080, 5173]

function windowsPids() {
  const command = `Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in ${ports.join(',')} } | Select-Object -ExpandProperty OwningProcess -Unique`
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-Command', command], { encoding: 'utf8' })
      .split(/\r?\n/)
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0)
  } catch {
    return []
  }
}

function unixPids() {
  try {
    return execFileSync('sh', ['-c', `lsof -tiTCP:${ports.join(',')} -sTCP:LISTEN 2>/dev/null`], { encoding: 'utf8' })
      .split(/\r?\n/)
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0)
  } catch {
    return []
  }
}

function stopStaleDevProcesses() {
  const pids = [...new Set(process.platform === 'win32' ? windowsPids() : unixPids())]
  for (const pid of pids) {
    if (process.platform === 'win32') {
      try { execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
    } else {
      try { process.kill(pid, 'SIGTERM') } catch {}
    }
  }
  if (pids.length) console.log(`[dev] 已清理旧开发进程：${pids.join(', ')}`)
}

stopStaleDevProcesses()

const children = new Map()
let shuttingDown = false

function printLines(name, stream) {
  const lines = createInterface({ input: stream })
  lines.on('line', (line) => process.stdout.write(`[${name}] ${line}\n`))
}

function start(name, script) {
  const child = process.platform === 'win32'
    ? spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `pnpm ${script}`], { stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn('pnpm', [script], { stdio: ['ignore', 'pipe', 'pipe'] })
  children.set(name, child)
  printLines(name, child.stdout)
  printLines(name, child.stderr)
  child.on('exit', (code, signal) => {
    children.delete(name)
    if (!shuttingDown && code !== 0) shutdown(code ?? 1, signal)
  })
}

function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  for (const child of children.values()) child.kill()
  process.exitCode = code
}

process.on('SIGINT', () => shutdown())
process.on('SIGTERM', () => shutdown())
start('relay', 'relay')
start('host', 'host')
start('web', 'web')
