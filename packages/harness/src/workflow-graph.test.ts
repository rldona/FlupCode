import { describe, expect, test } from "bun:test"
import { runGraph, workflowGraph } from "./workflow-graph"
import type { Task, Workflow } from "./types"

const task = (id: string, over: Partial<Workflow["tasks"][number]> = {}): Workflow["tasks"][number] => ({
  id,
  kind: "agent",
  ...over,
})

describe("laying a workflow out as a graph (H-28)", () => {
  test("a chain is one column per step", () => {
    const graph = workflowGraph([task("plan"), task("build"), task("verify", { kind: "verify" })])
    expect(graph.nodes.map((node) => `${node.id}@${node.depth}`)).toEqual(["plan@0", "build@1", "verify@2"])
    expect(graph.columns).toBe(3)
    expect(graph.edges).toEqual([
      { from: "plan", to: "build" },
      { from: "build", to: "verify" },
    ])
  })

  test("an external task is drawn as what it is (H-38)", () => {
    const graph = workflowGraph([task("codex", { kind: "external" })])
    expect(graph.nodes[0]!.kind).toBe("external")
  })

  test("tasks that can run together share a column", () => {
    const graph = workflowGraph([
      task("read"),
      task("left", { dependsOn: ["read"] }),
      task("right", { dependsOn: ["read"] }),
      task("join", { dependsOn: ["left", "right"] }),
    ])
    // The two that wait on `read` are at the same depth, which is what the runner will do with them.
    expect(graph.nodes.find((node) => node.id === "left")!.depth).toBe(1)
    expect(graph.nodes.find((node) => node.id === "right")!.depth).toBe(1)
    expect(graph.nodes.find((node) => node.id === "join")!.depth).toBe(2)
    expect(graph.columns).toBe(3)
  })

  test("`parallel` takes a task out of the chain, and `when` names a dependency", () => {
    const graph = workflowGraph([
      task("a"),
      task("b", { parallel: true }),
      task("recover", { when: { task: "b", is: ["failed"] } }),
    ])
    expect(graph.nodes.find((node) => node.id === "b")!.depth).toBe(0)
    expect(graph.nodes.find((node) => node.id === "b")!.dependsOn).toEqual([])
    // `recover` waits for `b` even though it never said `dependsOn`.
    expect(graph.nodes.find((node) => node.id === "recover")!.dependsOn).toEqual(["b"])
    expect(graph.nodes.find((node) => node.id === "recover")!.depth).toBe(1)
  })

  test("a `foreach` waits for the plan it splits", () => {
    const graph = workflowGraph([task("plan"), task("step", { foreach: "plan" })])
    expect(graph.nodes.find((node) => node.id === "step")!.dependsOn).toEqual(["plan"])
    expect(graph.nodes.find((node) => node.id === "step")!.depth).toBe(1)
  })

  test("a gate is carried so the picture can mark it", () => {
    const graph = workflowGraph([task("plan", { gate: "human" }), task("verify", { kind: "verify" })])
    expect(graph.nodes[0]!.gate).toBe(true)
    expect(graph.nodes[1]!.kind).toBe("verify")
  })
})

describe("a run on its workflow's graph (UX-04)", () => {
  const run = (over: Partial<Task> & Pick<Task, "id" | "name" | "position">): Task => ({
    runID: "run",
    prompt: "",
    status: "queued",
    ...over,
  })

  test("the run's tasks keep the shape the file gave them", () => {
    const graph = runGraph([
      run({ id: "a", name: "plan", position: 0, status: "success" }),
      run({ id: "b", name: "build", position: 1, status: "running" }),
      run({ id: "c", name: "docs", position: 2, status: "running", dependsOn: ["plan"] }),
      run({ id: "d", name: "check", position: 3, kind: "verify", dependsOn: ["build", "docs"] }),
    ])
    expect(graph.nodes.map((node) => `${node.id}@${node.depth}`)).toEqual(["plan@0", "build@1", "docs@1", "check@2"])
    expect(graph.nodes.find((node) => node.id === "check")!.kind).toBe("verify")
    expect(graph.edges).toContainEqual({ from: "docs", to: "check" })
    expect(graph.tasks.docs!.status).toBe("running")
  })

  test("a retry is the same node, and the node follows the newest attempt", () => {
    const graph = runGraph([
      run({ id: "a", name: "build", position: 0, status: "failed" }),
      run({ id: "b", name: "check", position: 1, status: "skipped" }),
      run({ id: "c", name: "build", position: 2, status: "running", attempt: 2, retryOf: "a" }),
    ])
    expect(graph.nodes.map((node) => node.id)).toEqual(["build", "check"])
    expect(graph.edges).toEqual([{ from: "build", to: "check" }])
    expect(graph.tasks.build!.id).toBe("c")
  })

  test("a plan's steps are one node, going while any step is", () => {
    const graph = runGraph([
      run({ id: "p", name: "plan", position: 0, status: "success" }),
      run({ id: "s1", name: "step", position: 1, status: "success", foreach: "plan" }),
      run({ id: "s2", name: "step", position: 2, status: "running", foreach: "plan" }),
      run({ id: "s3", name: "step", position: 3, status: "queued", foreach: "plan" }),
    ])
    expect(graph.nodes.map((node) => node.id)).toEqual(["plan", "step"])
    expect(graph.tasks.step!.id).toBe("s2")
  })
})
