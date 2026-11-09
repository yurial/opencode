import { afterEach, describe, expect, test } from "bun:test"
import { Context } from "effect"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

const context = Context.empty() as Context.Context<unknown>

function request(route: string, init: RequestInit = {}) {
  return HttpApiApp.webHandler().handler(new Request(`http://localhost${route}`, init), context)
}

function createSession(route: string, init: RequestInit = {}) {
  return request(route, {
    ...init,
    method: "POST",
    headers: { "content-type": "application/json", ...init.headers },
  })
}

async function createdDirectory(route: string, init: RequestInit = {}) {
  const response = await createSession(route, init)
  expect(response.status).toBe(200)
  const body = (await response.json()) as { data: { location: { directory: string } } }
  return body.data.location.directory
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("v2 session.create directory", () => {
  // First request in the file pays the cold HttpApiApp layer boot; later tests
  // reuse the warm router.
  test("uses the x-opencode-directory header when the payload has no location", async () => {
    await using tmp = await tmpdir({ git: true })
    expect(await createdDirectory("/api/session", { headers: { "x-opencode-directory": tmp.path }, body: "{}" })).toBe(
      tmp.path,
    )
  }, 30_000)

  test("uses the location[directory] query field when header and payload are absent", async () => {
    await using tmp = await tmpdir({ git: true })
    const query = new URLSearchParams({ "location[directory]": tmp.path })
    expect(await createdDirectory(`/api/session?${query}`, { body: "{}" })).toBe(tmp.path)
  })

  test("prefers the payload location over header and query", async () => {
    await using payload = await tmpdir({ git: true })
    await using header = await tmpdir({ git: true })
    await using query = await tmpdir({ git: true })
    const search = new URLSearchParams({ "location[directory]": query.path })
    expect(
      await createdDirectory(`/api/session?${search}`, {
        headers: { "x-opencode-directory": header.path },
        body: JSON.stringify({ location: { directory: payload.path } }),
      }),
    ).toBe(payload.path)
  })

  test("prefers the header over the query field", async () => {
    await using header = await tmpdir({ git: true })
    await using query = await tmpdir({ git: true })
    const search = new URLSearchParams({ "location[directory]": query.path })
    expect(
      await createdDirectory(`/api/session?${search}`, {
        headers: { "x-opencode-directory": header.path },
        body: "{}",
      }),
    ).toBe(header.path)
  })

  test("falls back to the server process cwd without any directory input", async () => {
    expect(await createdDirectory("/api/session", { body: "{}" })).toBe(process.cwd())
  })

  test("treats an empty location[directory] query value as absent", async () => {
    const query = new URLSearchParams({ "location[directory]": "" })
    expect(await createdDirectory(`/api/session?${query}`, { body: "{}" })).toBe(process.cwd())
  })

  test("treats an empty x-opencode-directory header as absent", async () => {
    expect(await createdDirectory("/api/session", { headers: { "x-opencode-directory": "" }, body: "{}" })).toBe(
      process.cwd(),
    )
  })

  test("rejects a nonexistent header directory with the declared InvalidRequestError", async () => {
    await using tmp = await tmpdir({ git: true })
    const missing = `${tmp.path}/missing`
    const response = await createSession("/api/session", {
      headers: { "x-opencode-directory": missing },
      body: "{}",
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      _tag: "InvalidRequestError",
      message: `Directory does not exist or is not accessible on the server: ${missing}`,
    })
  })

  test("rejects a malformed header directory that fails percent-decoding", async () => {
    // decodeURIComponent throws on the invalid %zz escape, so the raw string
    // becomes the candidate directory — which then cannot exist.
    const malformed = "%2ftmp%2fno-such-directory%zz"
    const response = await createSession("/api/session", {
      headers: { "x-opencode-directory": malformed },
      body: "{}",
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      _tag: "InvalidRequestError",
      message: expect.stringContaining(malformed),
    })
  })

  test("rejects a nonexistent query directory", async () => {
    await using tmp = await tmpdir({ git: true })
    const missing = `${tmp.path}/missing`
    const query = new URLSearchParams({ "location[directory]": missing })
    const response = await createSession(`/api/session?${query}`, { body: "{}" })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      _tag: "InvalidRequestError",
      message: expect.stringContaining(missing),
    })
  })

  test("rejects a nonexistent payload directory", async () => {
    await using tmp = await tmpdir({ git: true })
    const missing = `${tmp.path}/missing`
    const response = await createSession("/api/session", {
      body: JSON.stringify({ location: { directory: missing } }),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      _tag: "InvalidRequestError",
      message: expect.stringContaining(missing),
    })
  })
})
