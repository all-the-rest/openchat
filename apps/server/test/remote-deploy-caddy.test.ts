import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { CADDY_SH, cleanupTemp, run, stub, temp } from "./remote-deploy-fixtures"

/**
 * Findings 3 and 7: `caddy.sh` must validate a staged fragment + candidate
 * Caddyfile before either live file moves, and the backup path it prints must
 * exist. A fake `docker` runs the inner shell against a temp `/etc/caddy`, and a
 * fake `caddy` records the validate call (and can fail on demand).
 */

const DOCKER_STUB = `
cmd=$1; shift
case "$cmd" in
  inspect) printf 'true\\n' ;;
  exec)
    while [ "\${1:-}" = "-i" ] || [ "\${1:-}" = "-t" ]; do shift; done
    shift
    if [ "\${1:-}" = "sh" ] && [ "\${2:-}" = "-c" ]; then
      script=\${3//\\/etc\\/caddy/$FAKE_ROOT/etc/caddy}
      exec sh -c "$script"
    fi
    joined="$*"
    joined=\${joined//\\/etc\\/caddy/$FAKE_ROOT/etc/caddy}
    exec sh -c "$joined"
    ;;
esac
exit 0
`

const CADDY_STUB = `
printf '%s\\n' "$*" >> "$CADDY_LOG"
if [ "$1" = "validate" ]; then
  if [ -f "$FAKE_ROOT/etc/caddy/openchat.caddy" ]; then
    printf 'live-fragment=yes\\n' >> "$CADDY_LOG"
  else
    printf 'live-fragment=no\\n' >> "$CADDY_LOG"
  fi
  if [ -n "\${STUB_CADDY_INVALID:-}" ]; then
    printf 'Error: unrecognized response matcher not\\n' >&2
    exit 1
  fi
fi
exit 0
`

interface Fixture {
  root: string
  etc: string
  caddyfile: string
  caddyLog: string
  env: Record<string, string>
}

function fixture(): Fixture {
  const root = temp("openchat-caddy-")
  const etc = join(root, "etc", "caddy")
  const bin = join(root, "bin")
  mkdirSync(etc, { recursive: true })
  mkdirSync(bin)
  const caddyfile = 'example.com {\n\trespond "host site"\n}\n'
  writeFileSync(join(etc, "Caddyfile"), caddyfile)
  stub(bin, "docker", DOCKER_STUB)
  stub(bin, "caddy", CADDY_STUB)
  const caddyLog = join(root, "caddy.log")
  writeFileSync(caddyLog, "")
  return {
    root,
    etc,
    caddyfile,
    caddyLog,
    env: {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      FAKE_ROOT: root,
      DOCKER_LOG: join(root, "docker.log"),
      CADDY_LOG: caddyLog,
    },
  }
}

function install(test: Fixture, name = "fragment"): string {
  const fragment = join(test.root, name)
  writeFileSync(fragment, "chat.example.test {\n\trespond ok\n}\n")
  return fragment
}

afterEach(cleanupTemp)

describe("caddy.sh stages before it moves", { timeout: 30_000 }, () => {
  it("installs, validates the staged pair, keeps a backup and prints its path", () => {
    const test = fixture()
    const fragment = install(test)

    const result = run(CADDY_SH, ["--container", "caddy", "--fragment", fragment], test.env)
    expect(result.status, result.stderr).toBe(0)

    const live = readFileSync(join(test.etc, "Caddyfile"), "utf8")
    expect(live).toContain("import openchat.caddy")
    expect(readFileSync(join(test.etc, "openchat.caddy"), "utf8")).toBe(readFileSync(fragment, "utf8"))
    expect(readFileSync(join(test.etc, "Caddyfile.openchat.bak"), "utf8")).toBe(test.caddyfile)
    expect(result.stdout).toContain("/etc/caddy/Caddyfile.openchat.bak")
    expect(() => statSync(join(test.etc, ".openchat-stage"))).toThrow()

    const log = readFileSync(test.caddyLog, "utf8")
    expect(log).toMatch(/\.openchat-stage\/Caddyfile --adapter caddyfile/)
    // On a first install the live fragment does not exist at validate time.
    expect(log).toContain("live-fragment=no")
  })

  it("leaves both live files byte-identical when validation fails", () => {
    const test = fixture()
    expect(run(CADDY_SH, ["--fragment", install(test)], test.env).status).toBe(0)

    const before = {
      caddyfile: readFileSync(join(test.etc, "Caddyfile")),
      fragment: readFileSync(join(test.etc, "openchat.caddy")),
    }
    const broken = join(test.root, "broken")
    writeFileSync(broken, "chat.example.test { BROKEN }\n")

    const result = run(CADDY_SH, ["--fragment", broken], { ...test.env, STUB_CADDY_INVALID: "1" })
    expect(result.status).not.toBe(0)
    expect(readFileSync(join(test.etc, "Caddyfile"))).toEqual(before.caddyfile)
    expect(readFileSync(join(test.etc, "openchat.caddy"))).toEqual(before.fragment)
    expect(existsSync(join(test.etc, ".openchat-stage"))).toBe(false)
  })

  it("removes the import and fragment only after a successful validation", () => {
    const test = fixture()
    expect(run(CADDY_SH, ["--fragment", install(test)], test.env).status).toBe(0)

    const before = {
      caddyfile: readFileSync(join(test.etc, "Caddyfile")),
      fragment: readFileSync(join(test.etc, "openchat.caddy")),
    }
    const failed = run(CADDY_SH, ["--remove"], { ...test.env, STUB_CADDY_INVALID: "1" })
    expect(failed.status).not.toBe(0)
    expect(readFileSync(join(test.etc, "Caddyfile"))).toEqual(before.caddyfile)
    expect(readFileSync(join(test.etc, "openchat.caddy"))).toEqual(before.fragment)

    expect(run(CADDY_SH, ["--remove"], test.env).status).toBe(0)
    expect(readFileSync(join(test.etc, "Caddyfile"), "utf8")).not.toContain("import openchat.caddy")
    expect(existsSync(join(test.etc, "openchat.caddy"))).toBe(false)
    // The backup is the pre-install file and survives a removal.
    expect(readFileSync(join(test.etc, "Caddyfile.openchat.bak"), "utf8")).toBe(test.caddyfile)
  })

  it("keeps the first backup and prints it once", () => {
    const test = fixture()
    const first = run(CADDY_SH, ["--fragment", install(test)], test.env)
    expect(first.status, first.stderr).toBe(0)
    expect(first.stdout).toContain("/etc/caddy/Caddyfile.openchat.bak")

    // A second install must not overwrite the pre-install file with the
    // already-importing one, and must not claim a new backup.
    const second = run(CADDY_SH, ["--fragment", install(test, "fragment2")], test.env)
    expect(second.status, second.stderr).toBe(0)
    expect(second.stdout).not.toContain("pre-install Caddyfile kept")
    expect(readFileSync(join(test.etc, "Caddyfile.openchat.bak"), "utf8")).toBe(test.caddyfile)
  })

  it("prints validate before moving in a dry run", () => {
    const test = fixture()
    const fragment = install(test)
    const result = run(CADDY_SH, ["--dry-run", "--fragment", fragment], test.env)
    expect(result.status).toBe(0)
    expect(result.stdout.indexOf("caddy validate")).toBeLessThan(result.stdout.indexOf("move"))
    expect(result.stdout).toContain("Caddyfile.openchat.bak")
  })
})
