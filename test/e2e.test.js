'use strict'
const test = require('brittle')
const path = require('path')
const fs = require('fs')
const { spawn, spawnSync } = require('child_process')
const process = require('process')
const tmp = require('test-tmp')
const LocalDrive = require('localdrive')
const pearBuild = require('pear-build')
const { platform, arch, isWindows } = require('which-runtime')

const root = path.dirname(__dirname)
const npm = isWindows ? 'npm.cmd' : 'npm'
const pearDev = isWindows ? 'pear.dev.cmd' : './pear.dev'
const pearExe = isWindows ? 'pear.exe' : 'pear'
const host = `${platform}-${arch}`
const pearRepo = process.env.PEAR_INSTALL_E2E_PEAR_REPO || 'https://github.com/holepunchto/pear.git'

test(
  'e2e installs pear and boots sidecar',
  { skip: isWindows || typeof Bare !== 'undefined' },
  async function (t) {
    t.timeout(900_000)

    const dir = await tmp(t)
    const pearDir = path.join(dir, 'pear')
    const installDir = path.join(dir, 'install')
    const buildDir = path.join(pearDir, 'out', 'build')
    const homeDir = path.join(dir, 'home')
    const installedPear = path.join(installDir, pearExe)
    const existingSidecars = pearSidecarPids()
    const env = {
      ...process.env,
      HOME: homeDir,
      PATH: `${installDir}${path.delimiter}${process.env.PATH || ''}`
    }
    await fs.promises.mkdir(homeDir, { recursive: true })
    t.teardown(() => cleanupProcesses(dir, homeDir, existingSidecars))
    // TODO: once we have an actual release on a key we can replace a big chuck
    // and run on a published key instead of main branch
    t.comment('clone pear')
    await exec(t, 'git', ['clone', '--depth', '1', pearRepo, pearDir], { env })

    t.comment('install pear dependencies')
    await exec(t, npm, ['install'], { cwd: pearDir, env })

    t.comment('use local pear-install checkout')
    await new LocalDrive(root)
      .mirror(new LocalDrive(path.join(pearDir, 'node_modules', 'pear-install')), {
        prune: true,
        ignore: ['/node_modules', '/.git', '/coverage']
      })
      .done()

    t.comment('touch pear upgrade link')
    const touch = await exec(t, pearDev, ['touch', '--json'], { cwd: pearDir, env })
    const link = findJson(touch.stdout, 'touch', 'final')?.data?.link
    t.ok(link, `touched ${link}`)

    t.comment('replace package upgrade links')
    const pkgPath = path.join(pearDir, 'package.json')
    const pkg = JSON.parse(await fs.promises.readFile(pkgPath, 'utf8'))
    pkg.upgrade.production = link
    pkg.upgrade.dev = link
    pkg.upgrade.stage = link
    await fs.promises.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n')

    t.comment('make pear')
    await exec(t, npm, ['run', 'make'], { cwd: pearDir, env })

    t.comment('run pear-build')
    await pearBuild({
      package: pkgPath,
      [`${platform}${arch[0].toUpperCase() + arch.slice(1)}App`]: path.join(
        pearDir,
        'by-arch',
        host,
        'bin',
        pearExe
      ),
      target: buildDir
    }).done()

    t.comment('stage build')
    const stage = await exec(t, pearDev, ['stage', link, buildDir, '--json'], { cwd: pearDir, env })
    t.ok(findJson(stage.stdout, 'stage', 'final')?.data?.success, 'staged successfully')

    t.comment('seed build')
    const seed = spawn(pearDev, ['seed', link, '--json', '--no-tty'], {
      cwd: pearDir,
      env,
      detached: !isWindows,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    seed.killGroup = !isWindows
    t.teardown(() => terminate(seed))
    await waitForJson(seed, 'seed', 'announced')

    t.comment('install pear')
    await fs.promises.mkdir(installDir, { recursive: true })
    const install = await exec(t, pearDev, ['install', '--to', installDir, '--json', link], {
      cwd: pearDir,
      env
    })
    t.ok(findJson(install.stdout, 'install', 'final')?.data?.success, 'installed successfully')

    t.comment('run installed pear smoke tests')
    t.ok(fs.existsSync(installedPear), `installed ${installedPear}`)
    const help = await exec(t, installedPear, ['help'], { cwd: dir, env })
    t.ok(help.stdout.includes('pear'), 'help printed')

    t.comment('boot installed sidecar')
    const sidecar = spawn(installedPear, ['sidecar'], {
      cwd: dir,
      env,
      detached: !isWindows,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    sidecar.killGroup = !isWindows
    t.teardown(() => terminate(sidecar))
    t.teardown(() =>
      shutdownSidecar(t, installedPear, {
        cwd: dir,
        env
      })
    )
    const boot = await waitForOutput(sidecar, /Current process is now Sidecar|Sidecar Booting/)
    t.ok(boot, 'sidecar booted')
    await shutdownSidecar(t, installedPear, { cwd: dir, env })
    await terminate(sidecar)
    await terminate(seed)
    await cleanupProcesses(dir, homeDir, existingSidecars)
  }
)

function exec(t, cmd, args, opts = {}) {
  const timeout = opts.timeout || 300_000
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const timer = setTimeout(() => {
      terminate(child)
      reject(new Error(`Timed out: ${cmd} ${args.join(' ')}`))
    }, timeout)

    child.stdout.on('data', (data) => {
      stdout += data
    })
    child.stderr.on('data', (data) => {
      stderr += data
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      if (code === 0) return resolve({ stdout, stderr })
      t.comment(stdout)
      t.comment(stderr)
      reject(new Error(`${cmd} ${args.join(' ')} exited with ${code || signal}`))
    })
  })
}

function findJson(stdout, cmd, tag) {
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) continue
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (parsed.cmd === cmd && parsed.tag === tag) return parsed
  }
  return null
}

function waitForJson(child, cmd, tag, timeout = 120_000) {
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out waiting for ${cmd}:${tag}\n${stdout}\n${stderr}`))
    }, timeout)
    const cleanup = () => {
      clearTimeout(timer)
      child.stdout.off('data', onstdout)
      child.stderr.off('data', onstderr)
      child.off('exit', onexit)
      child.off('error', onerror)
    }
    const onstdout = (data) => {
      stdout += data
      const found = findJson(stdout, cmd, tag)
      if (!found) return
      cleanup()
      resolve(found.data)
    }
    const onstderr = (data) => {
      stderr += data
    }
    const onexit = (code, signal) => {
      cleanup()
      reject(new Error(`${cmd} exited before ${tag}: ${code || signal}\n${stdout}\n${stderr}`))
    }
    const onerror = (err) => {
      cleanup()
      reject(err)
    }
    child.stdout.on('data', onstdout)
    child.stderr.on('data', onstderr)
    child.on('exit', onexit)
    child.on('error', onerror)
  })
}

function waitForOutput(child, pattern, timeout = 120_000) {
  return new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out waiting for ${pattern}\n${output}`))
    }, timeout)
    const cleanup = () => {
      clearTimeout(timer)
      child.stdout.off('data', ondata)
      child.stderr.off('data', ondata)
      child.off('exit', onexit)
      child.off('error', onerror)
    }
    const ondata = (data) => {
      output += data
      if (!pattern.test(output)) return
      cleanup()
      resolve(output)
    }
    const onexit = (code, signal) => {
      cleanup()
      reject(new Error(`Process exited before output matched: ${code || signal}\n${output}`))
    }
    const onerror = (err) => {
      cleanup()
      reject(err)
    }
    child.stdout.on('data', ondata)
    child.stderr.on('data', ondata)
    child.on('exit', onexit)
    child.on('error', onerror)
  })
}

async function terminate(child) {
  if (!child || child.exitCode !== null) return
  signal(child, 'SIGTERM')
  const exited = await waitForExit(child, 5000)
  if (exited) return
  signal(child, 'SIGKILL')
  await waitForExit(child, 5000)
}

function signal(child, name) {
  const pid = child.pid
  if (!pid) return
  try {
    process.kill(child.killGroup ? -pid : pid, name)
  } catch {}
}

function waitForExit(child, timeout) {
  if (child.exitCode !== null) return true
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off('exit', onexit)
      resolve(false)
    }, timeout)
    const onexit = () => {
      clearTimeout(timer)
      resolve(true)
    }
    child.once('exit', onexit)
  })
}

async function shutdownSidecar(t, cmd, opts) {
  try {
    await exec(t, cmd, ['sidecar', 'shutdown'], { ...opts, timeout: 30_000 })
  } catch {}
}

async function cleanupProcesses(dir, homeDir, existingSidecars) {
  const pids = new Set()
  collectMatchingPids(pids, dir)
  collectOpenFilePids(pids, homeDir)
  collectNewSidecarPids(pids, existingSidecars)
  pids.delete(String(process.pid))

  for (const pid of pids) killPid(pid, 'SIGTERM')
  if (pids.size > 0) await new Promise((resolve) => setTimeout(resolve, 1000))
  for (const pid of pids) killPid(pid, 'SIGKILL')
}

function collectNewSidecarPids(pids, existing) {
  for (const pid of pearSidecarPids()) {
    if (!existing.has(pid)) pids.add(pid)
  }
}

function pearSidecarPids() {
  const pids = new Set()
  const ps = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
  if (ps.status !== 0) return pids
  for (const line of ps.stdout.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/)
    if (match && match[2].trim() === 'pear-sidecar') pids.add(match[1])
  }
  return pids
}

function collectMatchingPids(pids, dir) {
  const ps = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
  if (ps.status !== 0) return
  for (const line of ps.stdout.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(.*)$/)
    if (!match) continue
    if (match[2].includes(dir)) pids.add(match[1])
  }
}

function collectOpenFilePids(pids, dir) {
  const lsof = spawnSync('lsof', ['-t', '+D', dir], { encoding: 'utf8' })
  if (lsof.status !== 0 && lsof.status !== 1) return
  for (const line of lsof.stdout.split(/\r?\n/)) {
    if (/^\d+$/.test(line)) pids.add(line)
  }
}

function killPid(pid, signal) {
  try {
    process.kill(Number(pid), signal)
  } catch {}
}
