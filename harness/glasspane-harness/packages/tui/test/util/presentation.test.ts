import { expect, test } from "bun:test"
import { sessionEpilogue } from "../../src/util/presentation"

test("formats session continuation summary", () => {
  const epilogue = sessionEpilogue({ title: "A session", sessionID: "ses_123" })
  expect(epilogue).toContain("A session")
  // The product's own command: this line is meant to be copied and pasted, so
  // it must name the binary the product installs.
  expect(epilogue).toContain("glasspane-harness -s ses_123")
  expect(epilogue).not.toContain("opencode")
})

test("omits the continuation line when there is no session id", () => {
  // A session that has not loaded yet has no id. Printing the line anyway
  // produced `glasspane-harness -s undefined`, which looks like a runnable
  // command and is not one.
  const epilogue = sessionEpilogue({ title: "A session" })
  expect(epilogue).toContain("A session")
  expect(epilogue).not.toContain("Continue")
  expect(epilogue).not.toContain("undefined")
})
