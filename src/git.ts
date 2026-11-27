/**
 * Describe the delegating workspace's git checkout so the cloud sandbox can
 * mount the same repository.
 *
 * @module dsh-qoder-bots/git
 */

import { execFile } from 'node:child_process'

export interface LocalRepository {
  readonly url: string
  readonly github: boolean
  readonly name: string
  readonly mountPath: string
  readonly remoteUsername?: string
  readonly branch?: string
  readonly head: string
  readonly checkout: { type: 'branch'; name: string } | { type: 'commit'; sha: string }
  readonly warnings: readonly string[]
}

type Git = (args: readonly string[]) => Promise<string | undefined>

function gitIn(cwd: string, signal?: AbortSignal): Git {
  return args => new Promise((resolve) => {
    execFile('git', args, {
      cwd,
      timeout: 10_000,
      ...signal === undefined ? {} : { signal },
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }, (error, stdout) => {
      resolve(error === null ? stdout.trim() : undefined)
    })
  })
}

export function httpsRemote(remote: string): string | undefined {
  const trimmed = remote.trim()
  const scp = /^[\w.-]+@([\w.-]+):(?!\/)(.+)$/.exec(trimmed)
  if (scp !== null) return `https://${scp[1]}/${scp[2]}`
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return undefined
  }
  if (url.protocol === 'ssh:' || url.protocol === 'git+ssh:') {
    return `https://${url.hostname}${url.pathname}`
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
  url.username = ''
  url.password = ''
  return url.toString()
}

export const WORKSPACE_ROOT = '/data/workspace'

export function httpsRemoteUsername(remote: string): string | undefined {
  let url: URL
  try {
    url = new URL(remote.trim())
  } catch {
    return undefined
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
  const username = decodeURIComponent(url.username)
  return username.length > 0 && username !== 'git' ? username : undefined
}

export async function detectRepository(cwd: string, signal?: AbortSignal): Promise<LocalRepository | undefined> {
  const git = gitIn(cwd, signal)
  const top = await git(['rev-parse', '--show-toplevel'])
  if (top === undefined) return undefined
  const remote = await git(['config', '--get', 'remote.origin.url'])
  const url = remote === undefined ? undefined : httpsRemote(remote)
  const remoteUsername = remote === undefined ? undefined : httpsRemoteUsername(remote)
  const head = await git(['rev-parse', 'HEAD'])
  if (url === undefined || head === undefined) return undefined

  const warnings: string[] = []
  const branchName = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'])
  let branch: string | undefined
  if (branchName !== undefined && branchName.length > 0) {
    const remoteHead = await git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branchName}`])
    if (remoteHead !== undefined) {
      branch = branchName
      if (remoteHead !== head) {
        const ahead = await git(['rev-list', '--count', `refs/remotes/origin/${branchName}..HEAD`])
        if (ahead !== undefined && ahead !== '0') {
          warnings.push(`${ahead} local commit(s) on ${branchName} are not pushed to origin; the cloud bot works from origin/${branchName}.`)
        }
      }
    } else {
      warnings.push(`branch ${branchName} has no origin counterpart (last fetched state); the cloud bot starts from the default branch and fetches commit ${head.slice(0, 12)}, which must exist on origin.`)
    }
  }
  const dirty = await git(['status', '--porcelain', '--untracked-files=no'])
  if (dirty !== undefined && dirty.length > 0) {
    warnings.push('the local working tree has uncommitted changes that the cloud bot cannot see.')
  }

  const name = (url.replace(/\/+$/, '').split('/').pop() ?? 'repo').replace(/\.git$/, '') || 'repo'
  return {
    url,
    github: new URL(url).hostname.toLowerCase() === 'github.com',
    name,
    mountPath: `${WORKSPACE_ROOT}/${name}`,
    ...remoteUsername === undefined ? {} : { remoteUsername },
    ...branch === undefined ? {} : { branch },
    head,
    checkout: branch === undefined ? { type: 'commit', sha: head } : { type: 'branch', name: branch },
    warnings,
  }
}
