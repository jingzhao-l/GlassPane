const logo = {
  left: ["                   ", "█▀▀█ █▀▀█ █▀▀█ █▀▀▄", "█__█ █__█ █^^^ █__█", "▀▀▀▀ █▀▀▀ ▀▀▀▀ ▀~~▀"],
  right: ["             ▄     ", "█▀▀▀ █▀▀█ █▀▀█ █▀▀█", "█___ █__█ █__█ █^^^", "▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀"],
}

const reset = "\x1b[0m"
const bold = "\x1b[1m"
const dim = "\x1b[90m"

function wordmark(pad = "") {
  const draw = (line: string, fg: string, shadow: string, bg: string) =>
    [...line]
      .map((char) => {
        if (char === "_") return `${bg} ${reset}`
        if (char === "^") return `${fg}${bg}▀${reset}`
        if (char === "~") return `${shadow}▀${reset}`
        if (char === " ") return " "
        return `${fg}${char}${reset}`
      })
      .join("")

  return logo.left.map((line, index) => {
    const left = draw(line, dim, "\x1b[38;5;235m", "\x1b[48;5;235m")
    const right = draw(logo.right[index] ?? "", reset, "\x1b[38;5;238m", "\x1b[48;5;238m")
    return `${pad}${left} ${right}`
  })
}

/**
 * The one-pane summary printed when a session ends.
 *
 * Two things this must not do, both of which it used to do:
 *
 *  - print the upstream binary's name. Users copy this line to resume, so the
 *    command has to be the one that exists on *their* machine — the product
 *    installs as `glasspane-harness` / `gp-harness`, and an `opencode` here is
 *    a command that does not resolve.
 *  - print `undefined`. `sessionID` is optional because the session may not
 *    have loaded yet; interpolating it blindly produced the literal
 *    `glasspane-harness -s undefined`, which reads like a real command and is
 *    not one. The continuation line is now omitted unless there is an id.
 */
export function sessionEpilogue(input: { title: string; sessionID?: string }) {
  const weak = (text: string) => `${dim}${text.padEnd(10, " ")}${reset}`
  const lines = [...wordmark("  "), "", `  ${weak("Session")}${bold}${input.title}${reset}`]
  if (input.sessionID !== undefined) {
    lines.push(`  ${weak("Continue")}${bold}glasspane-harness -s ${input.sessionID}${reset}`)
  }
  lines.push("")
  return lines.join("\n")
}
