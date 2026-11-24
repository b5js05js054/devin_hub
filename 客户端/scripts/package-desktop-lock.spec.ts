import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, it, expect } from 'vitest'
import { acquirePackageDesktopLock } from './package-desktop-lock.mjs'
import { removeFixtureSafely } from './test-fixture-cleanup.ts'

const fixtures: string[] = []

afterEach(() => {
  for (const fixture of fixtures.splice(0)) removeFixtureSafely(fixture)
})

function fixture(): string {
  const directory = mkdtempSync(join(tmpdir(), 'package-desktop-lock-'))
  fixtures.push(directory)
  return directory
}

it('rejects a concurrent launcher and allows a new run after release', async () => {
  const directory = fixture()
  const release = await acquirePackageDesktopLock(directory)
  await expect(acquirePackageDesktopLock(directory)).rejects.toThrow('已有一键打包任务正在运行')
  await release()
  expect(existsSync(join(directory, 'package-desktop.lock'))).toBe(false)
  const next = await acquirePackageDesktopLock(directory)
  await next()
})

it('takes over a lock whose recorded process no longer exists', async () => {
  const directory = fixture()
  const lock = join(directory, 'package-desktop.lock')
  writeFileSync(lock, '2147483647\n')
  const release = await acquirePackageDesktopLock(directory)
  expect(readFileSync(lock, 'utf8')).toBe(`${process.pid}\n`)
  await release()
})

it('does not delete a malformed or active lock', async () => {
  const directory = fixture()
  const lock = join(directory, 'package-desktop.lock')
  writeFileSync(lock, 'not-a-pid\n')
  await expect(acquirePackageDesktopLock(directory)).rejects.toThrow('已有一键打包任务正在运行')
  expect(readFileSync(lock, 'utf8')).toBe('not-a-pid\n')
})
