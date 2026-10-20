import { spawnSync } from 'node:child_process'

// The docker CLI the test drives the image with, and whether it can run here.
export function probeDocker(): { ok: true } | { ok: false; reason: string } {
  if (process.platform !== 'linux') return { ok: false, reason: 'the image runs on Linux' }
  if (spawnSync('docker', ['info'], { stdio: 'ignore' }).status !== 0) {
    return { ok: false, reason: '`docker info` fails: no container engine' }
  }
  return { ok: true }
}

export const docker = (args: string[], input?: string) => {
  const result = spawnSync('docker', args, { encoding: 'utf8', input, maxBuffer: 64 * 1024 ** 2 })
  return { code: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

export const must = (args: string[], input?: string) => {
  const result = docker(args, input)
  if (result.code !== 0) {
    throw new Error(
      `docker ${args.slice(0, 2).join(' ')} exited with ${result.code}: ${result.stderr}${result.stdout}`,
    )
  }
  return result.stdout
}
