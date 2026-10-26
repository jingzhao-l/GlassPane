/**
 * `launchctl print gui/501/com.glasspane.update`, captured verbatim on this machine on 2026-10-26 with
 * the update agent registered for real and the job idle — one file, so the two suites that read the
 * loaded definition (`launchd.test.mjs` for the readers themselves, `enable.test.mjs` for the CLI that
 * consults them) cannot drift into two different ideas of what launchd says.
 *
 * Why it is load-bearing. Both readers of the loaded job were written against shapes this repo
 * invented, and the invented shapes were what the fixtures fed them, so CI was green while production
 * was not:
 *
 *   · `parseLaunchctlEnvironment` split each entry at `=`. launchd writes `KEY => value`, so the left
 *     half of the arrow was consumed and the value kept the `>`: every held value came back as
 *     `"> /usr/local/bin:…"`. The comparison in `registerAgent` then answered "the loaded job's
 *     environment still differs from the definition this run rendered in PATH, NODE_EXTRA_CA_CERTS"
 *     about a job whose environment was byte-identical — measured on this machine at 21:47 on
 *     2026-10-26 with the shipped 1.21.0 updater, exit 3, on the very `enable` the panel's update
 *     button runs.
 *   · `parseLaunchctlSchedule` looked for a `start calendar interval = { … }` block. launchd prints no
 *     such thing: the daily interval reaches the book as `event triggers → <label> → descriptor →
 *     "Hour" => 12`. That reader answered `null` on every real machine, which meant the schedule
 *     comparison added on 2026-10-19 had never once run — a stale definition survived the argv
 *     read-back with the hour still wrong, and `enable` exited 0.
 *
 * `default environment` and `inherited environment` are in here on purpose. Only the merged
 * `environment` block is the job's own; a reader that matched those two would compare launchd's
 * minimum PATH against the one this tool rendered and refuse a correct registration.
 */
export const PRINT_AGENT = [
  'gui/501/com.glasspane.update = {',
  '\tactive count = 0',
  '\tpath = /Users/ethanlin/Library/LaunchAgents/com.glasspane.update.plist',
  '\ttype = LaunchAgent',
  '\tstate = not running',
  '',
  '\tprogram = /bin/sh',
  '\targuments = {',
  '\t\t/bin/sh',
  '\t\t-c',
  '\t\t"$0" "$1" check "$2" "$3" --json && "$0" "$1" apply "$2" "$3" --auto --json',
  '\t\t/usr/local/bin/node',
  '\t\t/Users/ethanlin/.glasspane/runtime/agent-entry.js',
  '\t\t--state-root',
  '\t\t/Users/ethanlin/.glasspane',
  '\t}',
  '',
  '\tstdout path = /Users/ethanlin/.glasspane/update.log',
  '\tstderr path = /Users/ethanlin/.glasspane/update.log',
  '\tinherited environment = {',
  '\t\tNO_PROXY => 127.0.0.1,localhost,::1,192.168.0.0/16,10.0.0.0/8,100.64.0.0/10',
  '\t\tALL_PROXY => socks5://127.0.0.1:15556',
  '\t\tSSH_AUTH_SOCK => /var/run/com.apple.launchd.fqhCodUUG6/Listeners',
  '\t}',
  '',
  '\tdefault environment = {',
  '\t\tPATH => /usr/bin:/bin:/usr/sbin:/sbin',
  '\t}',
  '',
  '\tenvironment = {',
  '\t\tOSLogRateLimit => 64',
  '\t\tNODE_EXTRA_CA_CERTS => /Users/ethanlin/.glasspane/ca-roots.pem',
  '\t\tPATH => /usr/local/bin:/Users/ethanlin/.npm-global/bin:/opt/homebrew/bin:/opt/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
  '\t\tXPC_SERVICE_NAME => com.glasspane.update',
  '\t}',
  '',
  '\tdomain = gui/501 [100023]',
  '\tasid = 100023',
  '\tminimum runtime = 600',
  '\texit timeout = 5',
  '\truns = 0',
  '\tlast exit code = (never exited)',
  '',
  '\tevent triggers = {',
  '\t\tcom.glasspane.update.268435474 => {',
  '\t\t\tkeepalive = 0',
  '\t\t\tservice = com.glasspane.update',
  '\t\t\tstream = com.apple.launchd.calendarinterval',
  '\t\t\tmonitor = com.apple.UserEventAgent-Aqua',
  '\t\t\tdescriptor = {',
  '\t\t\t\t"Minute" => 30',
  '\t\t\t\t"Hour" => 12',
  '\t\t\t}',
  '\t\t}',
  '\t}',
  '',
  '\tevent channels = {',
  '\t\t"com.apple.launchd.calendarinterval" = {',
  '\t\t\tport = 0x0',
  '\t\t\tactive = 0',
  '\t\t\tmanaged = 1',
  '\t\t\treset = 0',
  '\t\t\thide = 0',
  '\t\t\twatching = 1',
  '\t\t}',
  '\t}',
  '',
  '\tspawn type = daemon (3)',
  '\tjetsam memory limit (active) = (unlimited)',
  '',
  '\tproperties = inferred program',
  '}',
  '',
].join('\n')

/** The three facts the captured job carries, named once so controls read as comparisons. */
export const CAPTURED_CLI = '/Users/ethanlin/.glasspane/runtime/agent-entry.js'
export const CAPTURED_STATE_ROOT = '/Users/ethanlin/.glasspane'
export const CAPTURED_PATH = '/usr/local/bin:/Users/ethanlin/.npm-global/bin:/opt/homebrew/bin:/opt/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
export const CAPTURED_CA = '/Users/ethanlin/.glasspane/ca-roots.pem'
export const CAPTURED_SCHEDULE = { hour: 12, minute: 30 }

/**
 * One `event triggers` child, in the byte shape of the captured job. The extra triggers the controls
 * use are **constructed** (this machine holds exactly one) and they exist to prove a reader picks a
 * trigger by its `stream` rather than by position — the only way a job with more than one event source
 * can be read without lying about the hour.
 */
export const calendarTriggerBlock = (label, stream, hour, minute) => [
  `\t\t${label} => {`,
  '\t\t\tkeepalive = 0',
  '\t\t\tservice = com.glasspane.update',
  `\t\t\tstream = ${stream}`,
  '\t\t\tmonitor = com.apple.UserEventAgent-Aqua',
  '\t\t\tdescriptor = {',
  `\t\t\t\t"Minute" => ${minute}`,
  `\t\t\t\t"Hour" => ${hour}`,
  '\t\t\t}',
  '\t\t}',
].join('\n')

/// Insert extra trigger blocks as siblings *inside* `event triggers = { … }`.
export const withTriggers = (...blocks) => PRINT_AGENT.replace(
  '\tevent triggers = {\n',
  `\tevent triggers = {\n${blocks.join('\n')}\n`,
)
