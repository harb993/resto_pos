/**
 * One live connection between two tills, and everything that can travel down it.
 *
 * The master dials, the node accepts, and from that point the socket is symmetric:
 * either end can ask the other a question and get an answer back. Both ends run this
 * same class — what differs is only which handlers they install.
 *
 * Three things this exists to get right, all of them lessons from the old one-way
 * design:
 *
 *   - A call must never hang forever. Every outgoing request carries a timeout and a
 *     typed failure, so a till whose master vanished mid-sale gets a clear refusal
 *     instead of a spinner nobody can explain.
 *   - A dropped link must be NOTICED. A silent TCP connection can be dropped by a
 *     cheap switch without either end seeing an error, so both ends ping and both
 *     ends give up on silence. The old code only reconnected when a read failed,
 *     which on a half-open socket is never.
 *   - A close must fail every request in flight, immediately and with a reason.
 *     Leaving them pending is how a till ends up frozen rather than merely offline.
 */

import type { Socket } from 'node:net'
import { StringDecoder } from 'node:string_decoder'
import log from 'electron-log/main'
import {
  MAX_FRAME_BYTES, HEARTBEAT_MS, LINK_IDLE_TIMEOUT_MS, REQUEST_TIMEOUT_MS,
  FILE_TIMEOUT_MS, FILE_CHUNK_BYTES,
  type LinkFrame, type LinkErrorCode, type NodeCommand, type FileTransfer,
  type Identity,
} from './protocol'
import type { IpcResponse } from '../../shared/types'

export interface LinkHandlers {
  /** A call the other end wants run here. Node→master carries the real work. */
  onRequest?: (channel: string, payload: unknown) => Promise<IpcResponse>
  /** An instruction from the master. Only a node installs this. */
  onCommand?: (command: NodeCommand) => Promise<IpcResponse>
  /** A change on the master that this machine's screens should see. */
  onEvent?: (event: string, data: unknown) => void
  /** A whole file that arrived intact — the mirror, or a nightly backup. */
  onFile?: (meta: FileTransfer, data: Buffer) => Promise<IpcResponse>
  /**
   * What the other end's clock reads, from the heartbeat it just sent.
   *
   * Two tills with clocks a few minutes apart disagree about what "today" means, and
   * therefore about which shift a sale belongs to and which orders a driver is still
   * carrying. The books are safe either way — every row is written on the master, in
   * the master's time — but the second till's SCREEN was reading its own clock, so
   * the same day's takings could be filtered differently on the two machines.
   */
  onPeerTime?: (peerNow: number) => void
  /** The link is gone. Always called exactly once. */
  onClose?: (reason: string) => void
}

interface Pending {
  resolve: (result: IpcResponse) => void
  timer: NodeJS.Timeout
  what: string
}

/** A refusal shaped like every other answer, so callers need no special case. */
function refuse(code: LinkErrorCode, error: string): IpcResponse {
  return { success: false, error, code } as IpcResponse
}

export class Link {
  readonly peer: Identity
  readonly label: string
  readonly since = Date.now()

  private socket: Socket
  private handlers: LinkHandlers
  private buffer = ''
  /**
   * Bytes → text, kept across chunks.
   *
   * `socket.setEncoding()` cannot be used here: Node forbids it on a socket that came
   * from an HTTP upgrade (RFC 7230 §3), and the node's side of every link is exactly
   * that. Decoding by hand would then split a multi-byte character whenever one
   * straddled a chunk boundary — and every message in this app is Arabic, so that is
   * not a rare case but the normal one. StringDecoder holds the partial character
   * back until the rest of it arrives.
   */
  private decoder = new StringDecoder('utf8')
  private nextId = 1
  private pending = new Map<number, Pending>()
  /** Chunks of a file still arriving, by transfer id. */
  private incoming = new Map<number, { meta: FileTransfer; parts: string[] }>()
  private heartbeat: NodeJS.Timeout | null = null
  private lastTraffic = Date.now()
  private closed = false
  private closeReason = ''

  constructor(socket: Socket, peer: Identity, handlers: LinkHandlers, label: string) {
    this.socket = socket
    this.peer = peer
    this.handlers = handlers
    this.label = label

    // Nagle batches small writes, and every frame here is small and latency-sensitive
    // — a 40ms delay on each hop is felt at the till.
    socket.setNoDelay(true)
    socket.setKeepAlive(true, HEARTBEAT_MS)

    socket.on('data', (chunk: Buffer) => this.onData(chunk))
    socket.on('error', err => this.destroy(`socket error: ${(err as Error)?.message}`))
    socket.on('close', () => this.destroy('socket closed'))
    socket.on('end', () => this.destroy('peer hung up'))

    this.heartbeat = setInterval(() => this.tick(), HEARTBEAT_MS)
  }

  get alive(): boolean {
    return !this.closed
  }

  get lastSeen(): number {
    return this.lastTraffic
  }

  // ---- Sending ----

  /**
   * Ask the other end to run a channel, and wait for its answer.
   *
   * This is the node's only way to touch the books, so its failure modes are the
   * ones a cashier actually sees. Each is named rather than lumped into one message.
   */
  request(channel: string, payload: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<IpcResponse> {
    return this.await({ t: 'req', channel, payload }, `القناة ${channel}`, timeoutMs)
  }

  /** Tell the other end to do something, and find out whether it did. */
  command(command: NodeCommand, timeoutMs = REQUEST_TIMEOUT_MS): Promise<IpcResponse> {
    return this.await({ t: 'cmd', command }, `الأمر ${command.kind}`, timeoutMs)
  }

  /** Fire-and-forget. Events are a mirror of what already happened, not a request. */
  sendEvent(event: string, data: unknown): void {
    this.write({ t: 'evt', event, data })
  }

  /**
   * Push a whole file across in chunks and wait for the receiver to confirm it
   * landed. Chunked because a 30 MB database in one frame would block every other
   * message on the link — including the heartbeat, which would then declare the link
   * dead in the middle of a transfer that was going fine.
   */
  async sendFile(meta: FileTransfer, data: Buffer): Promise<IpcResponse> {
    if (this.closed) return refuse('no-link', 'انقطع الاتصال قبل إرسال الملف')

    const id = this.nextId++
    const b64 = data.toString('base64')
    const total = Math.max(1, Math.ceil(b64.length / FILE_CHUNK_BYTES))

    const answer = new Promise<IpcResponse>(resolve => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve(refuse('timeout', `انتهت مهلة نقل «${meta.name}» إلى ${this.peer.machineName}`))
      }, FILE_TIMEOUT_MS)
      this.pending.set(id, { resolve, timer, what: `الملف ${meta.name}` })
    })

    for (let seq = 0; seq < total; seq++) {
      if (this.closed) break
      const chunk = b64.slice(seq * FILE_CHUNK_BYTES, (seq + 1) * FILE_CHUNK_BYTES)
      this.write({ t: 'file', id, meta, seq, last: seq === total - 1, chunk })
      // Let the socket drain between chunks so ordinary traffic still gets through.
      await this.drain()
    }

    return answer
  }

  private await(
    frame: { t: 'req'; channel: string; payload: unknown } | { t: 'cmd'; command: NodeCommand },
    what: string,
    timeoutMs: number,
  ): Promise<IpcResponse> {
    if (this.closed) {
      return Promise.resolve(refuse('no-link', `لا يوجد اتصال بـ ${this.peer.machineName}`))
    }
    const id = this.nextId++
    return new Promise<IpcResponse>(resolve => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        log.warn(`[Link ${this.label}] Timed out waiting for ${what}`)
        resolve(refuse('timeout', `لم يرد ${this.peer.machineName} على ${what} خلال المهلة`))
      }, timeoutMs)
      this.pending.set(id, { resolve, timer, what })
      this.write({ ...frame, id } as LinkFrame)
    })
  }

  private write(frame: LinkFrame): void {
    if (this.closed) return
    try {
      const line = JSON.stringify(frame)
      if (line.length > MAX_FRAME_BYTES) {
        log.error(`[Link ${this.label}] Refusing to send an oversized ${frame.t} frame`)
        return
      }
      this.socket.write(line + '\n')
    } catch (err: any) {
      this.destroy(`write failed: ${err?.message}`)
    }
  }

  private drain(): Promise<void> {
    // `write` returns false once the kernel buffer is full; waiting for 'drain' is
    // what stops a large file from queueing the whole transfer in memory at once.
    if (this.closed || this.socket.writableLength === 0) return Promise.resolve()
    return new Promise(resolve => {
      const done = () => { this.socket.off('drain', done); resolve() }
      this.socket.once('drain', done)
      // Never wait forever on a socket that has stopped moving.
      setTimeout(done, 5_000)
    })
  }

  // ---- Receiving ----

  private onData(chunk: Buffer): void {
    this.lastTraffic = Date.now()
    this.buffer += this.decoder.write(chunk)

    // A peer that never sends a newline must not be able to grow this without bound.
    if (this.buffer.length > MAX_FRAME_BYTES) {
      this.destroy('peer sent an oversized frame')
      return
    }

    const lines = this.buffer.split('\n')
    // Whatever follows the last newline is a partial frame still arriving.
    this.buffer = lines.pop() ?? ''

    for (const line of lines) {
      if (!line.trim()) continue
      let frame: LinkFrame
      try {
        frame = JSON.parse(line)
      } catch {
        log.warn(`[Link ${this.label}] Unreadable frame, ignoring`)
        continue
      }
      void this.dispatch(frame)
    }
  }

  private async dispatch(frame: LinkFrame): Promise<void> {
    switch (frame.t) {
      case 'ping':
        // The heartbeat doubles as a clock signal. It already had to carry a
        // timestamp, it already arrives every ten seconds, and a shop LAN's latency
        // is far below the precision anyone here needs.
        try {
          this.handlers.onPeerTime?.(frame.at)
        } catch { /* a clock is never worth dropping a link over */ }
        this.write({ t: 'pong', at: frame.at })
        return

      case 'pong':
        return // the traffic itself is the point

      case 'evt':
        try {
          this.handlers.onEvent?.(frame.event, frame.data)
        } catch (err: any) {
          log.warn(`[Link ${this.label}] Event handler threw:`, err?.message)
        }
        return

      case 'res':
      case 'fail': {
        const waiting = this.pending.get(frame.id)
        if (!waiting) return // already timed out; its caller has moved on
        this.pending.delete(frame.id)
        clearTimeout(waiting.timer)
        waiting.resolve(frame.t === 'res'
          ? frame.result
          : refuse(frame.code, frame.error))
        return
      }

      case 'req':
        await this.answer(frame.id, () => this.handlers.onRequest
          ? this.handlers.onRequest(frame.channel, frame.payload)
          : Promise.resolve(refuse('forbidden', 'هذا الطرف لا يستقبل طلبات')))
        return

      case 'cmd':
        await this.answer(frame.id, () => this.handlers.onCommand
          ? this.handlers.onCommand(frame.command)
          : Promise.resolve(refuse('forbidden', 'هذا الطرف لا يستقبل أوامر')))
        return

      case 'file':
        await this.receiveFile(frame)
        return
    }
  }

  /** Run a handler and always answer, whatever it does. A silent end hangs the caller. */
  private async answer(id: number, run: () => Promise<IpcResponse>): Promise<void> {
    try {
      this.write({ t: 'res', id, result: await run() })
    } catch (err: any) {
      log.error(`[Link ${this.label}] Handler threw:`, err?.message || err)
      this.write({
        t: 'fail', id, code: 'handler-threw',
        error: err?.message || 'فشل تنفيذ الطلب على الجهاز الآخر',
      })
    }
  }

  private async receiveFile(
    frame: Extract<LinkFrame, { t: 'file' }>,
  ): Promise<void> {
    let entry = this.incoming.get(frame.id)
    if (!entry) {
      entry = { meta: frame.meta, parts: [] }
      this.incoming.set(frame.id, entry)
      log.info(`[Link ${this.label}] Receiving ${frame.meta.kind} "${frame.meta.name}" (${frame.meta.bytes} bytes)`)
    }
    entry.parts[frame.seq] = frame.chunk
    if (!frame.last) return

    this.incoming.delete(frame.id)
    await this.answer(frame.id, async () => {
      if (!this.handlers.onFile) {
        return refuse('forbidden', 'هذا الجهاز لا يستقبل ملفات')
      }
      // A gap means a chunk was lost; concatenating around it would produce a file
      // that is the right shape and the wrong contents.
      if (entry!.parts.some(p => p === undefined)) {
        return refuse('handler-threw', `وصل «${entry!.meta.name}» ناقصاً`)
      }
      return this.handlers.onFile(entry!.meta, Buffer.from(entry!.parts.join(''), 'base64'))
    })
  }

  // ---- Liveness ----

  private tick(): void {
    if (this.closed) return
    const silent = Date.now() - this.lastTraffic
    if (silent > LINK_IDLE_TIMEOUT_MS) {
      this.destroy(`no traffic for ${Math.round(silent / 1000)}s`)
      return
    }
    this.write({ t: 'ping', at: Date.now() })
  }

  // ---- Ending ----

  close(reason = 'closed locally'): void {
    this.destroy(reason)
  }

  private destroy(reason: string): void {
    if (this.closed) return
    this.closed = true
    this.closeReason = reason

    if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null }

    // Fail everything still waiting. A caller left pending on a dead link is a till
    // that looks frozen rather than one that says it is offline.
    for (const [, waiting] of this.pending) {
      clearTimeout(waiting.timer)
      waiting.resolve(refuse('no-link', `انقطع الاتصال بـ ${this.peer.machineName} أثناء ${waiting.what}`))
    }
    this.pending.clear()
    this.incoming.clear()

    try { this.socket.destroy() } catch { /* already gone */ }

    log.info(`[Link ${this.label}] Closed — ${reason}`)
    try {
      this.handlers.onClose?.(reason)
    } catch (err: any) {
      log.warn(`[Link ${this.label}] Close handler threw:`, err?.message)
    }
  }

  get reason(): string {
    return this.closeReason
  }
}
