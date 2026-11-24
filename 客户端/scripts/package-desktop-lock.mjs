/** Single-instance coordination for the plain-Node one-click Desktop launcher. */

import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Whether an existing lock is held by a live process. */
function holderExited(record) {
  if (!/^\d+\n$/.test(record)) return false
  const pid = Number(record.trim())
  if (pid === 0 || pid > 0x7fffffff || pid === process.pid) return false
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return error.code === 'ESRCH'
  }
}

/** Read a lock record without treating a disappearing file as a dead holder. */
async function readRecord(lockPath) {
  try {
    return await readFile(lockPath, 'utf8')
  } catch (error) {
    void error
    return undefined
  }
}

/** Remove a stale lock only while holding the claim for its exact PID record. */
async function takeOverExitedLock(lockPath) {
  const record = await readRecord(lockPath)
  if (record === undefined || !holderExited(record)) return false
  const claim = `${lockPath}.takeover-${createHash('sha256').update(record).digest('hex').slice(0, 16)}`
  try {
    await writeFile(claim, `${process.pid}\n`, { mode: 0o600, flag: 'wx' })
  } catch (error) {
    if (error.code === 'EEXIST' || error.code === 'EPERM') return false
    throw error
  }
  try {
    if (await readRecord(lockPath) !== record || !holderExited(record)) return false
    await rm(lockPath, { force: true })
    return true
  } catch (error) {
    // Windows may briefly retain the stale file; the next launch can retry.
    void error
    return false
  } finally {
    await rm(claim, { force: true }).catch((error) => {
      // A stale claim is tied to this record and cannot block a later lock.
      void error
    })
  }
}

/**
 * Acquire the one-click launcher lock before opening the shared log.
 * @param {string} directory - Desktop build directory shared by launcher processes.
 * @returns {Promise<() => Promise<void>>} Idempotent release operation.
 */
export async function acquirePackageDesktopLock(directory) {
  await mkdir(directory, { recursive: true })
  const lockPath = join(directory, 'package-desktop.lock')
  for (;;) {
    try {
      await writeFile(lockPath, `${process.pid}\n`, { mode: 0o600, flag: 'wx' })
      let released = false
      return async () => {
        if (released) return
        released = true
        await rm(lockPath, { force: true })
      }
    } catch (error) {
      let contention = error.code === 'EEXIST'
      if (error.code === 'EPERM') {
        // Windows can report exclusive creation as EPERM while the file exists.
        contention = await lstat(lockPath).then(() => true, () => false)
      }
      if (!contention) throw error
      if (await takeOverExitedLock(lockPath)) continue
      throw new Error('已有一键打包任务正在运行，请等待它结束后再试。')
    }
  }
}
