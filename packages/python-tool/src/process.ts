import { spawn } from "node:child_process"

/**
 * The one place a Python process is started.
 *
 * A fixed command and argv, no shell, a minimal environment, a deadline and a
 * stdout cap. The classified outcome is a plain record, so the runner can be
 * driven by a fake in tests without a Python installation.
 */

export interface ProcessInvocation {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
  /** Written to stdin and closed. */
  input: string
  timeoutMs: number
  /** Above this many stdout bytes the child is killed and `stdoutOverflow` set. */
  maxStdoutBytes: number
}

export interface ProcessOutcome {
  status: number | null
  stdout: string
  stderr: string
  /** True when the deadline killed the child. */
  timedOut: boolean
  /** True when the command could not be started at all (typically ENOENT). */
  spawnFailed: boolean
  /** True when stdout crossed the cap. */
  stdoutOverflow: boolean
}

export type ProcessRunner = (invocation: ProcessInvocation) => Promise<ProcessOutcome>

/**
 * Default runner. stderr is collected only so the caller can classify a
 * failure; it is never forwarded to the model. A spawn error resolves instead
 * of rejecting, because the caller maps it to a fixed error code.
 */
export const runProcess: ProcessRunner = (invocation) =>
  new Promise((resolve) => {
    const chunks: Buffer[] = []
    const errors: Buffer[] = []
    let stdoutBytes = 0
    let timedOut = false
    let stdoutOverflow = false
    let settled = false

    let child
    try {
      child = spawn(invocation.command, invocation.args, {
        cwd: invocation.cwd,
        env: invocation.env,
        stdio: ["pipe", "pipe", "pipe"],
        // A new process group would need a signal the platform supports; the
        // direct child is the only process the scripts start.
        windowsHide: true,
      })
    } catch {
      resolve({
        status: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        spawnFailed: true,
        stdoutOverflow: false,
      })
      return
    }

    const finish = (outcome: ProcessOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(outcome)
    }

    const kill = (): void => {
      try {
        child.kill("SIGKILL")
      } catch {
        // A child that already exited cannot be killed; the close event wins.
      }
    }

    const timer = setTimeout(() => {
      timedOut = true
      kill()
    }, invocation.timeoutMs)

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength
      if (stdoutBytes > invocation.maxStdoutBytes) {
        stdoutOverflow = true
        kill()
        return
      }
      chunks.push(chunk)
    })
    child.stderr.on("data", (chunk: Buffer) => {
      // Keep at most 8 KiB: enough to classify, never enough to leak.
      if (errors.reduce((sum, part) => sum + part.byteLength, 0) < 8192) errors.push(chunk)
    })
    child.on("error", () => {
      finish({
        status: null,
        stdout: "",
        stderr: "",
        timedOut,
        spawnFailed: true,
        stdoutOverflow,
      })
    })
    child.on("close", (status) => {
      finish({
        status,
        stdout: Buffer.concat(chunks).toString("utf8"),
        stderr: Buffer.concat(errors).toString("utf8"),
        timedOut,
        spawnFailed: false,
        stdoutOverflow,
      })
    })

    child.stdin.on("error", () => {
      // EPIPE when the child dies before reading; the close event decides.
    })
    child.stdin.end(invocation.input)
  })
