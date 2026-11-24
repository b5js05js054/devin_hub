import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { claimNewFiles, listSavedFiles } from '../src/files.ts'

async function outputDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-tool-browser-files-'))
  onTestFinished(async () => { await rm(directory, { recursive: true, force: true }) })
  return directory
}

describe('listSavedFiles', () => {
  it('lists finished files and skips folders and downloads still in progress', async () => {
    const directory = await outputDirectory()
    await writeFile(join(directory, 'report.pdf'), 'pdf')
    await writeFile(join(directory, 'a-shot.png'), 'png')
    await writeFile(join(directory, 'Unconfirmed 4821.crdownload'), 'partial')
    await writeFile(join(directory, '3f2a.TMP'), 'partial')
    await mkdir(join(directory, 'folder.png'))
    expect(await listSavedFiles(directory)).toEqual(['a-shot.png', 'report.pdf'])
  })

  it('rejects a directory that does not exist', async () => {
    await expect(listSavedFiles(join(await outputDirectory(), 'absent'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('claimNewFiles', () => {
  it('reports each file once, including one whose download finished later', async () => {
    const directory = await outputDirectory()
    await writeFile(join(directory, 'earlier-run.png'), 'png')
    const known = new Set(await listSavedFiles(directory))
    expect(await claimNewFiles(directory, known)).toEqual([])

    await writeFile(join(directory, 'shot.png'), 'png')
    await writeFile(join(directory, 'big.zip.crdownload'), 'partial')
    expect(await claimNewFiles(directory, known)).toEqual(['shot.png'])
    expect(await claimNewFiles(directory, known)).toEqual([])

    await rm(join(directory, 'big.zip.crdownload'))
    await writeFile(join(directory, 'big.zip'), 'zip')
    expect(await claimNewFiles(directory, known)).toEqual(['big.zip'])
    expect([...known].sort()).toEqual(['big.zip', 'earlier-run.png', 'shot.png'])
  })
})
