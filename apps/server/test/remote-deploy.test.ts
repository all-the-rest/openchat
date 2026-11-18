import { spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

/**
 * The remote deployment layer: the derived OpenCode image, the SSH driver and
 * its helper scripts, the Caddy fragment and the host-only `.env` bootstrap.
 *
 * The tests read shell scripts as text or run them with local fixtures. No SSH,
 * no Docker daemon, no Caddy binary: the image build itself is proven separately
 * (`docker build -f deploy/Dockerfile.opencode …`), the Caddy file against
 * `caddy:2-alpine` (`caddy validate` prints `Valid configuration`).
 */

const ROOT = resolve(import.meta.dirname, "..", "..", "..")
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf8")

const DOCKERFILE = read("deploy", "Dockerfile.opencode")
const COMPOSE = read("compose.yaml")
const REMOTE = read("deploy", "remote", "compose.yaml")
const DEPLOY = read("deploy", "remote", "deploy.sh")
const BOOTSTRAP = read("deploy", "remote", "env-bootstrap.sh")
const ESCAPE = join(ROOT, "deploy", "remote", "env-value.sh")
const SEED = join(ROOT, "deploy", "remote", "seed-config.sh")
const DISKS = join(ROOT, "deploy", "remote", "mount-disks.sh")
const CADDY_SH = join(ROOT, "deploy", "remote", "caddy.sh")
const CADDY = read("deploy", "remote", "Caddyfile.openchat")
const ENV_TEMPLATE = read("deploy", "env.example")
const DOC = read("docs", "implementation", "20-remote-deploy.md")

const created: string[] = []
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  created.push(dir)
  return dir
}

function bash(args: string[], input = "", env: Record<string, string> = {}) {
  return spawnSync("bash", args, {
    encoding: "utf8",
    input,
    env: { ...process.env, ...env },
  })
}

function escapeValue(value: string): string {
  const result = bash([ESCAPE], value)
  expect(result.status, result.stderr).toBe(0)
  return result.stdout
}

/**
 * Docker Compose's env-file interpolation, reduced to what matters here: `$$`
 * is a literal `$`, `${VAR}` and `$VAR` expand (to nothing when unset), and a
 * `$` before a digit is literal. Returns the value the container would see.
 */
function composeRender(escaped: string): string {
  return escaped
    .replace(/\$\$/g, "\u0000")
    .replace(/\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*/g, "")
    .replace(/\u0000/g, "$")
}

const DIGEST = "$2b$12$spVi86mZhum2ngLrW8ZH7Om0ROPu20t.XaZYoEML6L42PCyOhQuQq"

describe("derived OpenCode image", () => {
  it("pins the official 2.3.2 base and never uses latest", () => {
    expect(DOCKERFILE).toContain("ARG OPENCODE_BASE=ghcr.io/anomalyco/opencode:2.3.2")
    expect(DOCKERFILE).toContain("FROM ${OPENCODE_BASE}")
    // `latest` is the stale 1.19.6 line (measured); no image may use it.
    expect(DOCKERFILE).not.toMatch(/^ARG OPENCODE_BASE=.*:latest$/m)
    expect(COMPOSE).toContain("ghcr.io/anomalyco/opencode:2.3.2")
    expect(COMPOSE).not.toMatch(/^\s*image:.*opencode:latest/m)
  })

  it("keeps the upstream entrypoint, CMD and user contract", () => {
    expect(DOCKERFILE).not.toMatch(/^ENTRYPOINT\b/m)
    expect(DOCKERFILE).not.toMatch(/^CMD\b/m)
    expect(DOCKERFILE).not.toMatch(/^USER\b/m)
    expect(DOCKERFILE).toContain('CMD ["opencode", "--version"]')
    // Compose passes arguments to the inherited `opencode` entrypoint.
    expect(COMPOSE).toMatch(/command:\n\s+- serve\n\s+- --hostname\n\s+- 0\.0\.0\.0\n\s+- --port/)
  })

  it("adds the runtime the official image lacks, with a verified Docker CLI", () => {
    expect(DOCKERFILE).toMatch(/apk add --no-cache [^\n]*\bgit\b/)
    expect(DOCKERFILE).toMatch(/apk add --no-cache [^\n]*\bnodejs\b/)
    expect(DOCKERFILE).toContain("sha256sum -c")
    expect(DOCKERFILE).toContain("ARG TARGETARCH=amd64")
    expect(DOCKERFILE).toContain("/opt/artifact-tool/node_modules/.bin/tsx")
    expect(DOCKERFILE).toContain(
      "COPY --from=tool /repo /opt/artifact-tool",
    )
  })

  it("copies only paths that exist in the repository", () => {
    const dockerfiles = [
      ...readdirSync(join(ROOT, "deploy"))
        .filter((name) => name.startsWith("Dockerfile"))
        .map((name) => join("deploy", name)),
      join("deploy", "code-host", "tools.Dockerfile"),
    ]

    for (const file of dockerfiles) {
      let text = read(file)
      // Join continuation lines so a wrapped COPY is parsed as one instruction.
      text = text.replace(/\\\r?\n/g, " ")
      for (const line of text.split("\n")) {
        const instruction = /^\s*COPY\s+(.+)$/.exec(line)?.[1]
        if (instruction === undefined) continue
        const tokens = instruction.trim().split(/\s+/)
        if (tokens[0]?.startsWith("--from=")) continue
        const sources = tokens.filter((token) => !token.startsWith("--")).slice(0, -1)
        for (const source of sources) {
          // Globs and remote URLs are not static paths.
          if (/[*?[]/.test(source) || /^https?:/.test(source)) continue
          const path = source.replace(/^\.?\//, "").replace(/\/$/, "")
          expect(existsSync(join(ROOT, path)), `${file}: COPY ${source} must exist`).toBe(true)
        }
      }
    }
  })
})

describe("remote overlay", () => {
  it("joins the host's existing proxy network with stable DNS aliases", () => {
    expect(REMOTE).toContain("external: true")
    expect(REMOTE).toContain("name: webnet")
    for (const alias of ["openchat-bff", "openchat-code-host", "openchat-artifact-host"]) {
      expect(REMOTE).toContain(alias)
    }
  })

  it("caps memory per service and does not shrink the BFF", () => {
    expect(REMOTE).toContain("mem_limit: 512m")
    expect(REMOTE).toContain("mem_limit: 256m")
    expect(REMOTE).toContain("mem_limit: 128m")
    expect(REMOTE).toContain("mem_limit: 1536m")
    expect(REMOTE).toContain("mem_limit: 1024m")
  })

  it("pins the in-stack upstream and leaves profiles to the deploy script", () => {
    expect(REMOTE).toContain("OPENCODE_URL: http://opencode:4096")
    expect(REMOTE).not.toMatch(/^\s+profiles:/m)
    expect(DEPLOY).toContain("COMPOSE_PROFILES")
  })
})

describe("deploy script", () => {
  it("prints a complete dry-run and changes nothing", () => {
    const result = bash([join(ROOT, "deploy", "remote", "deploy.sh"), "--dry-run", "--tag", "deadbeef"])
    expect(result.status, result.stderr).toBe(0)
    for (const step of ["rsync", "mount-disks.sh", "env-bootstrap.sh", "seed-config.sh", "swap.sh", "caddy.sh"]) {
      expect(result.stdout, `dry run must show ${step}`).toContain(step)
    }
    expect(result.stdout).toContain("dry run: nothing was synced")
    expect(result.stdout).not.toContain("OPENCHAT_PASSWORD_HASH=")
  })

  it("refuses a secret as an argument", () => {
    for (const args of [["OPENCHAT_PASSWORD=secret"], ["--password", "secret"]]) {
      const result = bash([join(ROOT, "deploy", "remote", "deploy.sh"), "--dry-run", ...args])
      expect(result.status).toBe(2)
      expect(result.stderr).toMatch(/refused|unknown argument/)
    }
  })

  it("records the disk layout and gates dind on available memory", () => {
    expect(DEPLOY).toContain("DIND_MIN_AVAILABLE_MIB=5120")
    expect(DEPLOY).toContain("/proc/meminfo")
    expect(DEPLOY).toContain("disks/layout")
    expect(DEPLOY).toContain("--with-dind")
  })
})

describe("dollar signs in .env", () => {
  it("doubles every `$` and stays idempotent", () => {
    expect(escapeValue(DIGEST)).toBe("$$2b$$12$$spVi86mZhum2ngLrW8ZH7Om0ROPu20t.XaZYoEML6L42PCyOhQuQq")
    expect(escapeValue("$$2b$$12$$abc")).toBe("$$2b$$12$$abc")
    expect(escapeValue(escapeValue(DIGEST))).toBe(escapeValue(DIGEST))
  })

  it("pins the measured corruption and proves the escape repairs it", () => {
    // Measured with `docker compose config`: `$2b` and `$12` are literal, the
    // segment after the third `$` is an unset variable and expands away.
    expect(composeRender("$2b$12$abc")).toBe("$2b$12")
    expect(composeRender(DIGEST)).toBe("$2b$12.XaZYoEML6L42PCyOhQuQq")
    expect(composeRender(escapeValue(DIGEST))).toBe(DIGEST)
  })

  it("documents the rule in the template", () => {
    expect(ENV_TEMPLATE).toMatch(/bcrypt digest[^]*?\$\$/)
    expect(ENV_TEMPLATE).toContain("OPENCHAT_PASSWORD_HASH=")
  })
})

describe("env bootstrap", () => {
  it("keeps an existing .env untouched and never reads the predecessor", () => {
    const stack = temp("openchat-env-")
    const file = join(stack, ".env")
    writeFileSync(file, "SENTINEL=1\n")
    const result = bash(
      [join(ROOT, "deploy", "remote", "env-bootstrap.sh"), "--stack-dir", stack, "--domain", "example.test"],
      "",
      { PREDECESSOR_ENV: join(stack, "absent.env") },
    )
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain("kept")
    expect(readFileSync(file, "utf8")).toBe("SENTINEL=1\n")
  })

  it("writes a 0600 file with an escaped digest and generated secrets", () => {
    const stack = temp("openchat-env-")
    const predecessor = join(stack, "predecessor.env")
    writeFileSync(predecessor, `AUTH_USER=owner\nAUTH_HASH=${DIGEST}\n`)

    const result = bash([
      join(ROOT, "deploy", "remote", "env-bootstrap.sh"),
      "--stack-dir", stack,
      "--predecessor-env", predecessor,
      "--domain", "example.test",
    ])
    expect(result.status, result.stderr).toBe(0)

    const file = join(stack, ".env")
    const text = readFileSync(file, "utf8")
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(text).toContain("APP_ORIGIN=https://chat.example.test")
    expect(text).toContain("CODE_HOST_ORIGIN=https://code.example.test")
    expect(text).toContain("ARTIFACT_HOST_URL=https://artifacts.example.test")
    expect(text).toContain("TRUST_PROXY=1")
    expect(text).toContain("COOKIE_SECURE=1")
    expect(text).toContain("OPENCHAT_USER=owner")
    expect(text).toContain(`OPENCHAT_PASSWORD_HASH=${escapeValue(DIGEST)}`)
    expect(text).toMatch(/^ARTIFACT_INTERNAL_TOKEN=[0-9a-f]{64}$/m)
    expect(text).toMatch(/^OPENCODE_PASSWORD=.{16,}$/m)

    // No value leaves the script through stdout or stderr.
    expect(result.stdout).not.toContain("spVi86")
    expect(result.stderr).not.toContain("spVi86")

    const before = readFileSync(file, "utf8")
    expect(
      bash([join(ROOT, "deploy", "remote", "env-bootstrap.sh"), "--stack-dir", stack, "--domain", "example.test"]).status,
    ).toBe(0)
    expect(readFileSync(file, "utf8")).toBe(before)
  })
})

describe("OpenCode MCP config", () => {
  it("seeds one local entry once, without printing the token", () => {
    const stack = temp("openchat-seed-")
    const token = "0123456789abcdef0123456789abcdef"
    writeFileSync(join(stack, ".env"), `ARTIFACT_INTERNAL_TOKEN=${token}\n`)

    const result = bash([SEED, "--stack-dir", stack])
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).not.toContain(token)

    const file = join(stack, "opencode-config", "opencode.json")
    const text = readFileSync(file, "utf8")
    expect(statSync(file).mode & 0o777).toBe(0o644)
    expect(text).toContain('"type": "local"')
    expect(text).toContain("/opt/artifact-tool/node_modules/.bin/tsx")
    expect(text).toContain("/opt/artifact-tool/packages/artifact-tool/src/index.ts")
    expect(text).toContain('"OPENCHAT_BFF_URL": "http://bff:8787"')
    expect(text).toContain(token)

    writeFileSync(file, `${text}\n`)
    const stamp = statSync(file).mtimeMs
    expect(bash([SEED, "--stack-dir", stack]).status).toBe(0)
    expect(readFileSync(file, "utf8")).toBe(`${text}\n`)
    expect(statSync(file).mtimeMs).toBe(stamp)
  })
})

describe("size-capped disks", () => {
  it("prints the 2/4/4 GiB plan without touching the disk", () => {
    const stack = temp("openchat-disks-")
    const result = bash([DISKS, "--stack-dir", stack, "--dry-run"])
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain("would: truncate -s 2G")
    expect(result.stdout).toContain("would: truncate -s 4G")
    expect(result.stdout).toContain("would: mkfs.ext4 -F -q")
    expect(existsSync(join(stack, "disks", "artifacts.img"))).toBe(false)
    expect(result.stdout).toContain("10.0 GiB reserve")
  })

  it("reads the recorded layout on a later run and refuses a busy unmount", () => {
    const stack = temp("openchat-disks-")
    mkdirSync(join(stack, "disks"), { recursive: true })
    writeFileSync(join(stack, "disks", "layout"), "artifacts=3G\nworkspace=4G\ndind=4G\nreserve=10G\n")
    const result = bash([DISKS, "--stack-dir", stack, "--dry-run"])
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain("would: truncate -s 3G")

    const script = readFileSync(DISKS, "utf8")
    expect(script).toContain("compose_running")
    expect(script).toContain("stop it before --umount")
  })
})

describe("Caddy fragment", () => {
  it("uses the named matcher that validates, never the invalid encode block", () => {
    expect(CADDY).not.toMatch(/encode\s+zstd\s+gzip\s*\{/)
    expect(CADDY).not.toMatch(/match\s*\{\s*\n\s*not header/)
    expect(CADDY.match(/@compressible not header Content-Type text\/event-stream\*/g)).toHaveLength(2)
    expect(CADDY.match(/encode @compressible zstd gzip/g)).toHaveLength(2)
  })

  it("declares three origins, SSE-safe proxying and app-level auth only", () => {
    for (const host of ["chat", "code", "artifacts"]) {
      expect(CADDY).toContain(`${host}.__OPENCHAT_DOMAIN__ {`)
    }
    expect(CADDY.match(/flush_interval -1/g)).toHaveLength(2)
    expect(CADDY.match(/header_up X-Forwarded-For \{remote_host\}/g)).toHaveLength(2)
    expect(CADDY).not.toMatch(/^\s*basic_auth\b/m)
    expect(CADDY).not.toMatch(/^\s*forward_auth\b/m)
    expect(CADDY).toContain("X-Frame-Options \"DENY\"")
  })

  it("installs by import, validates before the move, and can be removed", () => {
    const script = readFileSync(CADDY_SH, "utf8")
    expect(script).toContain("import openchat.caddy")
    expect(script).toContain("caddy validate")
    expect(script).toContain("caddy reload")
    expect(script).toContain("--remove")
    expect(script.indexOf("caddy validate")).toBeLessThan(script.indexOf("mv Caddyfile.openchat.tmp Caddyfile"))
  })
})

describe("runbook", () => {
  it("states the interpolation rule, the validation output and the API boundary", () => {
    expect(DOC).toContain("Dollar signs in `.env`")
    expect(DOC).toContain("$2b$12")
    expect(DOC).toContain("Valid configuration")
    expect(DOC).toContain("no HTTP auth")
    expect(DOC).toMatch(/network isolation/i)
  })
})
