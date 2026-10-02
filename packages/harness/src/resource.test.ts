import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { HarnessError } from "./client"
import { createResource } from "./resource"

// These run against Solid's browser build (`--conditions browser` in the test script): the server
// build's resources do not fetch outside a hydrating render.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("createResource", () => {
  test("a failed fetch keeps the last value and says why in failure()", async () => {
    const [fail, setFail] = createSignal(false)
    const [resource, actions] = createRoot(() =>
      createResource(
        () => "key",
        () => (fail() ? Promise.reject(new Error("harness said 500")) : Promise.resolve(["a"])),
      ),
    )
    await settle()
    expect(resource()).toEqual(["a"])
    expect(resource.failure()).toBeUndefined()

    setFail(true)
    void actions.refetch()
    await settle()
    expect(resource()).toEqual(["a"])
    expect(resource.failure()?.message).toBe("harness said 500")

    setFail(false)
    void actions.refetch()
    await settle()
    expect(resource.failure()).toBeUndefined()
  })

  test("the failure is the error the fetch threw, so a refused token keeps its code", async () => {
    const [resource] = createRoot(() =>
      createResource(
        () => "key",
        () => Promise.reject(new HarnessError(403, { error: "Forbidden", code: "invalid_token" })),
      ),
    )
    await settle()
    expect(resource()).toBeUndefined()
    expect(resource.failure()).toBeInstanceOf(HarnessError)
    expect((resource.failure() as HarnessError).code).toBe("invalid_token")
  })

  test("a thrown non-error still becomes an Error", async () => {
    const [resource] = createRoot(() => createResource(() => "key", () => Promise.reject("plain text")))
    await settle()
    expect(resource.failure()?.message).toBe("plain text")
  })
})
