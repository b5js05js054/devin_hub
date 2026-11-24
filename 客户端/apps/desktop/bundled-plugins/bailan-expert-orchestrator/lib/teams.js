/**
 * bailan-expert-orchestrator — expert teams + per-session composer selection
 *
 * The composer chip (lib/client.js, slot `conversation.input.left`) lets the
 * user pick experts or a saved team for ONE session instead of typing
 * "summon the X expert …" in every message. This module owns the host half:
 *
 *   - teams: named expert groups (≤ MAX_TEAM_MEMBERS members — the
 *     summon_experts hard cap), global to the preset runtime dir;
 *   - session selections: sessionId → { teamId } | { experts: [ref] };
 *   - the model-visible hint: sessionSelectionContext() renders the current
 *     selection of one session as runtime context (registered by lib/tools.js
 *     through ctx.systemPrompt.context, a durable user-role snapshot — the
 *     selection is therefore logged whenever the model sees it).
 *
 * Storage: <dst>/expert-sources/teams.json (beside sources.json and
 * custom-experts.json; never touched by the deploy refresh):
 *   { version: 1, revision, teams: [{id,name,description,members:[ref],
 *     createdAt,updatedAt}], sessions: { [sessionId]: {teamId?|experts?,
 *     updatedAt} } }
 * An expert ref is { source, file } — the merged-roster row identity (the
 * same pair `expertEnabled` and getExpertContent use). Names and titles are
 * resolved from merged/roster.json at read time, so a renamed, disabled or
 * removed expert never leaves a stale name behind: it shows as unavailable in
 * the UI and is omitted from the model hint.
 *
 * Team mutations share an optimistic lock (`expectedRevision`, same convention
 * as sources.json); session selections are last-write-wins per session and do
 * not bump the revision. Every function is synchronous, so one host process
 * never interleaves a read-modify-write.
 *
 * Errors carry `key` (invalid | duplicate | limit | conflict | missing) and a
 * bilingual message, matching the custom-expert error contract the client
 * already branches on.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { loadRegistry, loadSourcesState } from './index.js'

const SOURCES_DIRNAME = 'expert-sources'
const TEAMS_JSON = 'teams.json'
const CORE_SOURCE_ID = 'bundled-core'

/** Team count cap (keeps teams.json and the composer list bounded). */
export const MAX_TEAMS = 50
/** Members per team / experts per ad-hoc selection — summon_experts accepts at most 8. */
export const MAX_TEAM_MEMBERS = 8
/** Session selections kept on disk; the least recently updated are pruned. */
export const MAX_SESSION_SELECTIONS = 200

const TEAM_ID_RE = /^team-[0-9a-f]{8}$/
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SOURCE_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/
const TEAM_NAME_MAX = 40
const TEAM_DESCRIPTION_MAX = 500
const FILE_MAX = 512
const NAME_MAX = 256
const TITLE_MAX = 512

const TEAM_MESSAGES = {
  invalid: ['请检查团队名称（1-40 字）、说明（≤500 字）与成员（1-8 位，须为花名册中可用的专家）。', 'Check the team name (1-40 chars), description (≤500 chars) and members (1-8 experts available in the roster).'],
  duplicate: ['团队名称已被使用，请换一个名称。', 'This team name is already in use. Choose another name.'],
  limit: ['团队数量已达上限（50 个），请先删除不再使用的团队。', 'The limit of 50 teams has been reached. Delete an unused team first.'],
  conflict: ['团队数据已在其他窗口被修改，请刷新后重试。', 'Teams were changed in another window. Refresh and retry.'],
  missing: ['团队不存在或已删除。', 'The team does not exist or was deleted.'],
}

function teamError(key) {
  const e = new Error(`${key}: ${TEAM_MESSAGES[key][0]} / ${TEAM_MESSAGES[key][1]}`)
  e.key = key
  return e
}

function teamsJsonPath(dst) { return join(dst, SOURCES_DIRNAME, TEAMS_JSON) }
function rosterPath(dst) { return join(dst, SOURCES_DIRNAME, 'merged', 'roster.json') }

const norm = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '')

/** `source/file` — unambiguous because a source id never contains a slash. */
export function refKey(ref) { return `${ref.source}/${ref.file}` }

/** Control characters (incl. newlines) → space, whitespace collapsed, trimmed, capped. */
function cleanLine(value, max) {
  if (typeof value !== 'string') return ''
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
}

/** Multi-line text: newlines kept, other control characters replaced by a space, trimmed. */
function cleanText(value) {
  if (typeof value !== 'string') return ''
  return value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, ' ').trim()
}

/** The host prompt interpolator treats `{{name}}` as a variable reference and
 *  has no escape syntax; user/third-party text must never carry the braces. */
function neutralizeTemplates(text) {
  return text.replaceAll('{{', '«').replaceAll('}}', '»')
}

function normalizeRef(value) {
  if (!value || typeof value !== 'object') return null
  const source = typeof value.source === 'string' ? value.source : ''
  const file = typeof value.file === 'string' ? value.file : ''
  if (!SOURCE_ID_RE.test(source)) return null
  if (file.length < 1 || file.length > FILE_MAX || /[\u0000-\u001f\u007f]/.test(file)) return null
  return { source, file }
}

function uniqueRefs(values) {
  const out = []
  const seen = new Set()
  for (const value of Array.isArray(values) ? values : []) {
    const ref = normalizeRef(value)
    if (!ref) return null
    const key = refKey(ref)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(ref)
  }
  return out
}

// ── merged roster index (stat-validated cache) ──────────────────────────────

function fileStamp(path) {
  try {
    const s = statSync(path)
    return `${s.mtimeMs}:${s.size}`
  } catch {
    return null
  }
}

const EMPTY_INDEX = Object.freeze({ list: Object.freeze([]), byKey: new Map(), nameCount: new Map() })
const ROSTER_CACHE = new Map()

/** roster.json → rows in roster order. Mirrors rosterCandidates() in tools.js:
 *  core rows are never shadowed; `available` = summonable (neither shadowed
 *  nor disabled). `nameCount` counts normalized names over the non-shadowed
 *  rows — the candidate set resolveExpert() matches names against. */
function buildRosterIndex(roster) {
  const list = []
  const byKey = new Map()
  const push = (row, fallbackSource, shadowable) => {
    if (!row || typeof row.file !== 'string' || row.file.length < 1 || row.file.length > FILE_MAX) return
    const source = typeof row.source === 'string' && row.source ? row.source : fallbackSource
    if (typeof source !== 'string' || !SOURCE_ID_RE.test(source)) return
    const shadowed = shadowable && !!row.shadowed
    const disabled = !!row.disabled
    const entry = {
      source,
      file: row.file,
      name: cleanLine(row.name, NAME_MAX) || null,
      title: cleanLine(row.title, TITLE_MAX) || null,
      shadowed,
      disabled,
      available: !shadowed && !disabled,
    }
    const key = refKey(entry)
    if (byKey.has(key)) return
    byKey.set(key, entry)
    list.push(entry)
  }
  for (const row of Array.isArray(roster?.core) ? roster.core : []) push(row, CORE_SOURCE_ID, false)
  for (const src of Array.isArray(roster?.sources) ? roster.sources : []) {
    for (const row of Array.isArray(src?.files) ? src.files : []) push(row, src?.id, true)
  }
  const nameCount = new Map()
  for (const entry of list) {
    if (entry.shadowed || !entry.name) continue
    const key = norm(entry.name)
    nameCount.set(key, (nameCount.get(key) ?? 0) + 1)
  }
  return { list, byKey, nameCount }
}

function rosterIndex(dst) {
  const path = rosterPath(dst)
  const stamp = fileStamp(path)
  if (stamp === null) return EMPTY_INDEX
  const cached = ROSTER_CACHE.get(path)
  if (cached && cached.stamp === stamp) return cached.index
  let roster = null
  try { roster = JSON.parse(readFileSync(path, 'utf-8')) } catch { roster = null }
  const index = buildRosterIndex(roster)
  ROSTER_CACHE.set(path, { stamp, index })
  return index
}

/** The `expert` argument summon_expert(s) resolves for this row: the roster
 *  name when it is unique among candidates, otherwise the exact `source/file`
 *  ref (resolveExpert accepts it — see lib/tools.js). */
function summonNameOf(entry, index) {
  if (entry.name && index.nameCount.get(norm(entry.name)) === 1) return entry.name
  return refKey(entry)
}

/** Display names of the sources the roster rows come from (registry title, or
 *  the user-given name of an added source). Best effort: a missing registry
 *  only costs the label. bundled-core / custom are localized client-side. */
function sourceNames(dst) {
  const names = new Map()
  try {
    for (const reg of loadRegistry(dst)?.sources ?? []) {
      if (reg && typeof reg.id === 'string') names.set(reg.id, cleanLine(reg.title || reg.id, 128))
    }
  } catch { /* label only */ }
  try {
    for (const src of loadSourcesState(dst)?.sources ?? []) {
      if (src && typeof src.id === 'string' && !names.has(src.id) && src.name) names.set(src.id, cleanLine(src.name, 128))
    }
  } catch { /* label only */ }
  return names
}

// ── teams.json ──────────────────────────────────────────────────────────────

function emptyState() { return { version: 1, revision: 0, teams: [], sessions: {} } }

function normalizeTeam(raw) {
  if (!raw || typeof raw !== 'object' || !TEAM_ID_RE.test(String(raw.id))) return null
  const name = cleanLine(raw.name, TEAM_NAME_MAX)
  if (!name) return null
  const members = uniqueRefs(raw.members)
  if (!members || members.length < 1) return null
  return {
    id: raw.id,
    name,
    description: cleanText(raw.description).slice(0, TEAM_DESCRIPTION_MAX),
    members: members.slice(0, MAX_TEAM_MEMBERS),
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : null,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
  }
}

function normalizeSessionEntry(raw) {
  if (!raw || typeof raw !== 'object') return null
  const updatedAt = Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0
  if (typeof raw.teamId === 'string' && TEAM_ID_RE.test(raw.teamId)) return { teamId: raw.teamId, updatedAt }
  const experts = uniqueRefs(raw.experts)
  if (!experts || experts.length < 1) return null
  return { experts: experts.slice(0, MAX_TEAM_MEMBERS), updatedAt }
}

function normalizeState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('root must be an object')
  const state = emptyState()
  if (Number.isInteger(raw.revision) && raw.revision >= 0) state.revision = raw.revision
  const seen = new Set()
  for (const item of Array.isArray(raw.teams) ? raw.teams : []) {
    const team = normalizeTeam(item)
    if (!team || seen.has(team.id)) continue
    seen.add(team.id)
    state.teams.push(team)
  }
  const sessions = raw.sessions && typeof raw.sessions === 'object' && !Array.isArray(raw.sessions) ? raw.sessions : {}
  for (const [id, value] of Object.entries(sessions)) {
    if (!SESSION_ID_RE.test(id)) continue
    const entry = normalizeSessionEntry(value)
    if (entry) state.sessions[id] = entry
  }
  return state
}

const TEAMS_CACHE = new Map()

/** Load teams.json. A missing file is the empty state; a corrupt file throws
 *  (mutations must never silently overwrite data the user may want to fix). */
export function loadTeamsState(dst) {
  const path = teamsJsonPath(dst)
  if (!existsSync(path)) return emptyState()
  try {
    return normalizeState(JSON.parse(readFileSync(path, 'utf-8')))
  } catch (err) {
    throw new Error(`${SOURCES_DIRNAME}/${TEAMS_JSON} is corrupt: ${err.message}`)
  }
}

/** Prompt-path reader: stat-validated cache, never throws (null = no usable state). */
function readTeamsStateCached(dst) {
  const path = teamsJsonPath(dst)
  const stamp = fileStamp(path)
  if (stamp === null) return null
  const cached = TEAMS_CACHE.get(path)
  if (cached && cached.stamp === stamp) return cached.state
  let state = null
  try { state = loadTeamsState(dst) } catch { state = null }
  TEAMS_CACHE.set(path, { stamp, state })
  return state
}

function saveTeamsState(dst, state) {
  const path = teamsJsonPath(dst)
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n')
  renameSync(tmp, path)
  TEAMS_CACHE.delete(path)
}

function assertRevision(state, expectedRevision) {
  if (!Number.isInteger(expectedRevision) || expectedRevision !== state.revision) throw teamError('conflict')
}

function assertSessionId(sessionId) {
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) throw teamError('invalid')
  return sessionId
}

function ownSession(state, sessionId) {
  return Object.hasOwn(state.sessions, sessionId) ? state.sessions[sessionId] : null
}

// ── composer snapshot ───────────────────────────────────────────────────────

function viewMember(ref, index) {
  const entry = index.byKey.get(refKey(ref))
  return {
    source: ref.source,
    file: ref.file,
    name: entry?.name ?? null,
    title: entry?.title ?? null,
    available: entry?.available === true,
  }
}

function viewSelection(state, sessionId, index) {
  const entry = sessionId ? ownSession(state, sessionId) : null
  if (!entry) return { teamId: null, experts: [] }
  if (entry.teamId) {
    // A selection pointing at a deleted team reads as "nothing selected".
    return state.teams.some(team => team.id === entry.teamId)
      ? { teamId: entry.teamId, experts: [] }
      : { teamId: null, experts: [] }
  }
  return { teamId: null, experts: (entry.experts ?? []).map(ref => viewMember(ref, index)) }
}

/**
 * Everything the composer chip renders for one session.
 * @param dst preset runtime dir
 * @param sessionId client session id the selection belongs to
 * @param opts `catalog: true` adds the selectable expert list (omitted on the
 *        cheap per-mount read; the popover asks for it when it opens)
 * @returns `{ revision, catalog, experts[], teams[], selection, maxMembers, maxTeams }`
 */
export function buildComposerState(dst, sessionId, opts = {}) {
  assertSessionId(sessionId)
  const state = loadTeamsState(dst)
  const index = rosterIndex(dst)
  const catalog = opts.catalog === true
  let experts = []
  if (catalog) {
    const names = sourceNames(dst)
    experts = index.list.filter(entry => entry.available).map(entry => ({
      source: entry.source,
      file: entry.file,
      name: entry.name,
      title: entry.title,
      sourceName: names.get(entry.source) ?? null,
    }))
  }
  return {
    revision: state.revision,
    catalog,
    experts,
    teams: state.teams.map(team => ({
      id: team.id,
      name: team.name,
      description: team.description,
      members: team.members.map(ref => viewMember(ref, index)),
    })),
    selection: viewSelection(state, sessionId, index),
    maxMembers: MAX_TEAM_MEMBERS,
    maxTeams: MAX_TEAMS,
  }
}

// ── mutations ───────────────────────────────────────────────────────────────

/**
 * Create (no `input.id`) or update a team.
 * New members must be available roster experts; members already stored on the
 * edited team may stay even while their source is disabled.
 */
export function remoteSaveTeam(dst, input, expectedRevision, sessionId) {
  assertSessionId(sessionId)
  const state = loadTeamsState(dst)
  assertRevision(state, expectedRevision)
  const name = cleanLine(input?.name, 1000)
  if (!name || name.length > TEAM_NAME_MAX) throw teamError('invalid')
  const description = cleanText(input?.description)
  if (description.length > TEAM_DESCRIPTION_MAX) throw teamError('invalid')
  const members = uniqueRefs(input?.members)
  if (!members || members.length < 1 || members.length > MAX_TEAM_MEMBERS) throw teamError('invalid')

  const id = typeof input?.id === 'string' && input.id ? input.id : null
  const existing = id === null ? null : state.teams.find(team => team.id === id)
  if (id !== null && !existing) throw teamError('missing')
  if (id === null && state.teams.length >= MAX_TEAMS) throw teamError('limit')

  const index = rosterIndex(dst)
  const kept = new Set((existing?.members ?? []).map(refKey))
  for (const ref of members) {
    const key = refKey(ref)
    if (index.byKey.get(key)?.available !== true && !kept.has(key)) throw teamError('invalid')
  }
  if (state.teams.some(team => team.id !== id && norm(team.name) === norm(name))) throw teamError('duplicate')

  const now = new Date().toISOString()
  if (existing) {
    existing.name = name
    existing.description = description
    existing.members = members
    existing.updatedAt = now
  } else {
    let newId
    do { newId = `team-${randomUUID().replace(/-/g, '').slice(0, 8)}` } while (state.teams.some(team => team.id === newId))
    state.teams.push({ id: newId, name, description, members, createdAt: now, updatedAt: now })
  }
  state.revision += 1
  saveTeamsState(dst, state)
  return buildComposerState(dst, sessionId)
}

/** Delete a team; sessions that had it selected fall back to "nothing selected". */
export function remoteDeleteTeam(dst, teamId, expectedRevision, sessionId) {
  assertSessionId(sessionId)
  const state = loadTeamsState(dst)
  assertRevision(state, expectedRevision)
  const at = state.teams.findIndex(team => team.id === teamId)
  if (at < 0) throw teamError('missing')
  state.teams.splice(at, 1)
  for (const [id, entry] of Object.entries(state.sessions)) {
    if (entry.teamId === teamId) delete state.sessions[id]
  }
  state.revision += 1
  saveTeamsState(dst, state)
  return buildComposerState(dst, sessionId)
}

/**
 * Set what one session delegates to: `{ teamId }`, `{ experts: [ref] }`, or
 * nothing (`teamId: null` with no experts clears the entry). Last write wins;
 * the team revision is not bumped.
 */
export function remoteSetSessionSelection(dst, sessionId, selection) {
  assertSessionId(sessionId)
  const state = loadTeamsState(dst)
  const teamId = typeof selection?.teamId === 'string' && selection.teamId ? selection.teamId : null
  let entry = null
  if (teamId !== null) {
    if (!state.teams.some(team => team.id === teamId)) throw teamError('missing')
    entry = { teamId, updatedAt: Date.now() }
  } else {
    const experts = uniqueRefs(selection?.experts)
    if (!experts || experts.length > MAX_TEAM_MEMBERS) throw teamError('invalid')
    if (experts.length > 0) {
      const index = rosterIndex(dst)
      if (experts.some(ref => index.byKey.get(refKey(ref))?.available !== true)) throw teamError('invalid')
      entry = { experts, updatedAt: Date.now() }
    }
  }
  const had = ownSession(state, sessionId) !== null
  if (entry === null) {
    if (!had) return buildComposerState(dst, sessionId) // already clear: no write
    delete state.sessions[sessionId]
  } else {
    state.sessions[sessionId] = entry
    const ids = Object.keys(state.sessions)
    if (ids.length > MAX_SESSION_SELECTIONS) {
      ids.sort((a, b) => state.sessions[a].updatedAt - state.sessions[b].updatedAt)
      for (const id of ids.slice(0, ids.length - MAX_SESSION_SELECTIONS)) delete state.sessions[id]
    }
  }
  saveTeamsState(dst, state)
  return buildComposerState(dst, sessionId)
}

// ── model-visible hint ──────────────────────────────────────────────────────

/**
 * Resolve one session's selection against the current roster.
 * @returns `{ team: {name, description} | null, experts: [{summon, label}] }`,
 *          or null when nothing usable is selected (no entry, deleted team, or
 *          every member unavailable). Never throws.
 */
export function resolveSessionSelection(dst, sessionId) {
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) return null
  const state = readTeamsStateCached(dst)
  if (!state) return null
  const entry = ownSession(state, sessionId)
  if (!entry) return null
  let team = null
  let refs = entry.experts ?? []
  if (entry.teamId) {
    team = state.teams.find(item => item.id === entry.teamId) ?? null
    if (!team) return null
    refs = team.members
  }
  const index = rosterIndex(dst)
  const experts = []
  for (const ref of refs) {
    const row = index.byKey.get(refKey(ref))
    if (!row || !row.available) continue
    const summon = summonNameOf(row, index)
    const label = row.title && row.title !== summon ? row.title : row.name && row.name !== summon ? row.name : ''
    experts.push({ summon, label })
  }
  if (experts.length === 0) return null
  return { team: team ? { name: team.name, description: team.description } : null, experts }
}

/** Render a resolved selection as the runtime-context text the main agent reads. */
export function renderSelectionContext(resolved) {
  if (!resolved || !Array.isArray(resolved.experts) || resolved.experts.length === 0) return ''
  const count = resolved.experts.length
  const lines = ['## 本会话已指定专家（来自输入框的「专家」选择器）']
  lines.push(resolved.team
    ? `用户已为本会话选定专家团队「${resolved.team.name}」，成员 ${count} 位：`
    : `用户已为本会话选定 ${count} 位专家：`)
  for (const expert of resolved.experts) {
    lines.push(`- ${JSON.stringify(expert.summon)}${expert.label ? `（${expert.label}）` : ''}`)
  }
  if (resolved.team?.description) lines.push(`团队说明：${resolved.team.description}`)
  lines.push(
    `协作方式：用户发来需要专业处理的任务时，不必等用户再说“召唤某专家”——直接把任务委派给以上专家：${count > 1 ? '多位用 `summon_experts`，只需一位时用 `summon_expert`' : '用 `summon_expert`'}。`
      + '`expert` 参数原样填写上面引号内的名字；`task` 写成自包含的完整任务书（目标、范围、相关路径、交付要求）。'
      + `${count > 1 ? '可按任务内容只召唤相关成员；' : ''}专家返回后由你整合、核对，再向用户汇报。`,
    '寒暄、澄清提问、与这些专家领域无关的简单问题可直接回答。用户在输入框改选或清除专家后，以最新的指定为准。',
  )
  return neutralizeTemplates(lines.join('\n'))
}

/** Runtime-context text for one session ('' = nothing selected). Never throws. */
export function sessionSelectionContext(dst, sessionId) {
  try {
    return renderSelectionContext(resolveSessionSelection(dst, sessionId))
  } catch {
    return ''
  }
}

/**
 * The top-level session id of one prompt assembly, or null when the hint must
 * not apply: a bare assembly without an agent, or a subagent child (summoned
 * experts never inherit the parent's selection).
 */
export function sessionIdOfAssembleContext(context) {
  const session = context?.agent?.session
  if (!session) return null
  const header = session.header
  if (header?.origin === 'subagent' || (Number.isFinite(header?.delegationDepth) && header.delegationDepth > 0)) return null
  const id = header?.id ?? session.id
  return typeof id === 'string' && id ? id : null
}
