/** The direct tool returns the answer. A nested dispatch returns a job owned by the calling session. */
export function summonOutputSchema(properties) {
  return { oneOf: [
    { type: 'object', additionalProperties: false, properties },
    { type: 'object', additionalProperties: false, properties: {
      kind: { type: 'string', required: true, const: 'background' },
      jobId: { type: 'string', required: true },
    } },
  ] }
}

/** Run nested summons under job control. The initiating turn can still stop the accepted job. */
export function createSummonDispatcher(ctx) {
  const turnSignals = new WeakMap()
  ctx.on?.('agent/pre-step', ({ agent, signal }, next) => {
    turnSignals.set(agent, signal)
    return next()
  })

  return (exec, label, run) => {
    if (exec?.parent === undefined) return run(exec)
    exec.signal.throwIfAborted()
    const agent = exec.agent
    if (!agent) throw new Error('召唤专家需要主会话')
    const jobs = ctx.get('jobs')
    if (!jobs) throw new Error('后台专家需要宿主启用 jobs 和 tool-jobs')
    const turn = agent.status === 'idle' ? undefined : turnSignals.get(agent)
    const jobId = jobs.start({
      kind: 'expert', label, owner: agent.id,
      toolCall: { callId: exec.callId, rootCallId: exec.rootCallId },
      run() {
        const controller = new AbortController()
        const signal = turn ? AbortSignal.any([turn, controller.signal]) : controller.signal
        const cancelled = () => turn?.aborted ? { status: 'killed', notifyOwner: false } : { status: 'killed' }
        return {
          cancel: reason => controller.abort(reason),
          done: run({ agent, signal }).then(
            value => signal.aborted ? cancelled() : { status: 'completed', result: JSON.stringify(value) },
            error => signal.aborted ? cancelled() : { status: 'failed', detail: String(error?.message ?? error) },
          ),
        }
      },
    })
    return { kind: 'background', jobId }
  }
}

export function renderSummonReceipt(jobId) {
  return [{ type: 'text', text: `专家任务 ${jobId} 已在后台启动。收到完成通知后，用 job_output 领取结果。` }]
}
